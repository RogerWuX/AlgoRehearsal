import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { Logger } from '../../../../../shared/logger';

// Retain all SDK fields, including provider reasoning and search results.
export type Interaction = {
  id: string; status: string; environment_id?: string;
  steps?: { type: string; id?: string; name?: string; arguments?: unknown; call_id?: string; text?: string; content?: unknown }[];
  [key: string]: unknown;
};
export function interactionMessage(interaction: Interaction, log: Logger): AIMessage {
  const steps = interaction.steps ?? [];
  const executed = new Set(steps.filter(step => step.type === 'function_result').map(step => step.call_id));
  const calls: NonNullable<AIMessage['tool_calls']> = [];
  for (const step of steps) {
    if (step.type !== 'function_call' || interaction.status !== 'requires_action') continue;
    if (executed.has(step.id)) {
      log.debug('tool.skipped', { callId: step.id, reason: 'already-executed-by-server' });
      continue;
    }
    if (!step.id || !step.name) throw new Error('Antigravity returned an invalid tool call.');
    calls.push({ id: step.id, name: step.name, args: step.arguments as Record<string, unknown>, type: 'tool_call' });
  }
  const content = steps.flatMap(step => {
    if (typeof step.text === 'string') return [step.text];
    if (step.type === 'model_output' && Array.isArray(step.content)) {
      return step.content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []);
    }
    return [];
  }).join('\n');
  return new AIMessage({ content, tool_calls: calls,
    response_metadata: { interactionId: interaction.id, environmentId: interaction.environment_id,
      status: interaction.status, steps, interaction } });
}

export function continuationResults(messages: BaseMessage[], handled: Map<string, ToolMessage>) {
  let lastAI = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (AIMessage.isInstance(messages[i])) { lastAI = i; break; }
  }
  for (const message of messages) if (ToolMessage.isInstance(message)) handled.set(message.tool_call_id, message);
  const ai = messages[lastAI] as AIMessage | undefined;
  // LangChain may omit a duplicate call's new ToolMessage. Reuse the stored
  // result, while sending only the calls requested by this interaction.
  return (ai?.tool_calls ?? []).flatMap(call => {
    const message = handled.get(call.id!);
    return message ? [{ type: 'function_result' as const, name: call.name, call_id: call.id!,
      result: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }] : [];
  });
}
