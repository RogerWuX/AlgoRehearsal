import { GoogleGenAI } from '@google/genai/web';
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, type BaseMessage, type ToolMessage } from '@langchain/core/messages';
import { convertToOpenAIFunction } from '@langchain/core/utils/function_calling';
import { createMiddleware } from 'langchain/browser';
import type { Logger } from '../../../../../shared/logger';
import type { ResolvedAgentContext, ModelRunScope, ModelRunOptions } from '../../../llm/types';
import { invokeWithSignal } from '../../../llm/invokeWithSignal';
import { interactionMessage, continuationResults, type Interaction } from './interactionMapping';
import { waitForPoll, requestOptions, ANTIGRAVITY_POLL_INTERVAL_MS, REQUEST_TIMEOUT_MS } from './polling';

type ToolInput = Parameters<typeof convertToOpenAIFunction>[0] | Record<string, unknown>;
interface CallOptions extends BaseChatModelCallOptions { tools?: ToolInput[] }
type RunState = {
  lastInteraction?: Interaction; canceled: Set<string>; handled: Map<string, ToolMessage>;
  log: Logger; logPayloads: boolean; onMetadata?: ModelRunOptions['onMetadata']; signal: AbortSignal; disposed: boolean;
};
type Options = {
  apiKey: string; agent: string; pollIntervalMs?: number; requestTimeoutMs?: number;
  client?: GoogleGenAI; run?: RunState;
};

export class ChatAntigravity extends BaseChatModel<CallOptions> {
  private readonly client: GoogleGenAI;
  private readonly settings: Options;
  constructor(options: Options) {
    super({ maxRetries: 0 });
    this.settings = options;
    this.client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { apiVersion: 'v1beta' } });
  }
  _llmType() { return 'antigravity'; }
  bindTools(tools: ToolInput[], options: Partial<CallOptions> = {}) { return this.withConfig({ ...options, tools }); }

  createRunScope(context: ResolvedAgentContext, options: ModelRunOptions): ModelRunScope {
    const run: RunState = { canceled: new Set(), handled: new Map(), log: context.logger.child({ scope: 'antigravity' }),
      logPayloads: options.logPayloads, onMetadata: options.onMetadata, signal: context.signal, disposed: false };
    // A scope owns a clone and its state. The cached model owns only the SDK client.
    const scoped = new ChatAntigravity({ ...this.settings, client: this.client, run });
    const cancel = () => { void scoped.cancelActive(); };
    context.signal.addEventListener('abort', cancel, { once: true });
    return {
      middleware: [createMiddleware({ name: 'AntigravityRun', wrapModelCall: (request, handler) => handler({ ...request, model: scoped }) })],
      dispose: async () => {
        run.disposed = true;
        context.signal.removeEventListener('abort', cancel);
        await scoped.cancelActive();
      },
    };
  }

  private async cancelActive() {
    const run = this.settings.run;
    const active = run?.lastInteraction;
    // requires_action is paused for tool input, so the API cannot cancel it.
    if (!run || !active?.id || !['queued', 'in_progress'].includes(active.status) || run.canceled.has(active.id)) return;
    run.canceled.add(active.id);
    run.log.debug('interaction.cancel-requested', { interactionId: active.id, reason: run.signal.aborted ? 'operation-aborted' : 'operation-finished' });
    try { await this.client.interactions.cancel(active.id, {}, { timeout: 10000, maxRetries: 0 }); }
    catch { run.log.warn('interaction.cancel-failed', { interactionId: active.id }); }
  }

  async _generate(messages: BaseMessage[], options: CallOptions) {
    const run = this.settings.run;
    if (!run) throw new Error('Antigravity requires a per-run scope.');
    const { signal, log, logPayloads } = run;
    signal.throwIfAborted();
    const tools = (options.tools ?? []).map(tool => {
      if ('type' in tool && ['google_search', 'url_context'].includes(String(tool.type))) return tool;
      if ('type' in tool && tool.type === 'function' && 'function' in tool) {
        return { type: 'function', ...(tool.function as Record<string, unknown>) };
      }
      return { type: 'function', ...convertToOpenAIFunction(tool as Parameters<typeof convertToOpenAIFunction>[0]) };
    });
    const instructions = messages.find(SystemMessage.isInstance)?.text ?? '';
    const previous = run.lastInteraction;
    let input: string | ReturnType<typeof continuationResults>;
    if (previous) {
      input = continuationResults(messages, run.handled);
      if (!input.length) throw new Error('Antigravity requested action without pending tool calls.');
      if (!previous.environment_id) throw new Error('Antigravity returned no environment for continuation.');
      log.debug('interaction.continue', { previousInteractionId: previous.id, environmentId: previous.environment_id,
        ...(logPayloads ? { results: input } : { resultCount: input.length }) });
    } else {
      input = [...messages].reverse().find(HumanMessage.isInstance)?.text ?? '';
      log.debug('interaction.create', { agent: this.settings.agent, ...(logPayloads ? { systemInstruction: instructions, input } : {}) });
    }
    const track = async (request: PromiseLike<unknown>): Promise<Interaction> => {
      // Track late SDK responses even when abort has already rejected the run.
      const tracked = Promise.resolve(request).then(async value => {
        const interaction = value as Interaction;
        run.lastInteraction = interaction;
        log.debug('interaction.response', logPayloads ? { interaction } : { interactionId: interaction.id, status: interaction.status });
        if (signal.aborted || run.disposed) {
          log.debug('interaction.stale-response', { reason: signal.aborted ? 'operation-aborted' : 'operation-finished', interactionId: interaction.id });
          await this.cancelActive();
        }
        signal.throwIfAborted();
        run.onMetadata?.({ interactionId: interaction.id, steps: interaction.steps ?? [] });
        return interaction;
      });
      return invokeWithSignal(() => tracked, signal);
    };
    const parameters = {
      agent: this.settings.agent, input, system_instruction: instructions, tools,
      ...(previous ? { previous_interaction_id: previous.id, environment: previous.environment_id } : { environment: 'remote' }),
      background: true, store: true, stream: false,
    };
    // The generic converter emits the SDK's function/tool shapes; keep the
    // SDK-specific assertion at this boundary instead of leaking its types.
    let interaction = await track(this.client.interactions.create(parameters as Parameters<typeof this.client.interactions.create>[0],
      requestOptions(signal, this.settings.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)));
    while (interaction.status === 'queued' || interaction.status === 'in_progress') {
      const intervalMs = this.settings.pollIntervalMs ?? ANTIGRAVITY_POLL_INTERVAL_MS;
      log.debug('interaction.poll-wait', { interactionId: interaction.id, status: interaction.status, intervalMs });
      await waitForPoll(signal, intervalMs);
      interaction = await track(this.client.interactions.get(interaction.id, {}, requestOptions(signal, this.settings.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)));
    }
    log.debug('interaction.status-decision', { interactionId: interaction.id, status: interaction.status });
    const message = interactionMessage(interaction, log);
    return { generations: [{ message, text: message.text }] };
  }
}
