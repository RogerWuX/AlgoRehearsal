import { createMiddleware } from 'langchain/browser';
import { ToolMessage } from '@langchain/core/messages';
import type { Logger } from '../../../../shared/logger';
import type { Problem } from '../../model/problem';

export const SELECTION_MISSING = 'Problem selection finished without submitting a valid problem. Check the selection instructions and retry.';
export function createSelectionMiddleware({ log, signal, getAccepted, onResponse, managed }: {
  log: Logger; signal: AbortSignal; getAccepted(): Problem | undefined;
  onResponse(response: import('@langchain/core/messages').AIMessage): void; managed: boolean;
}) {
  let turn = 0;
  const handled = new Map<string, ToolMessage>();
  let queue = Promise.resolve();
  let toolFailed = false;
  return createMiddleware({
    name: 'ProblemSelection',
    beforeModel: { canJumpTo: ['end'], hook: () => getAccepted() ? { jumpTo: 'end' as const } : undefined },
    wrapModelCall: async (request, handler) => {
      log.debug('llm.request', { turn: ++turn, messages: [request.systemMessage, ...request.messages] });
      const response = await handler(request);
      log.debug('llm.response', { turn, response });
      signal.throwIfAborted();
      onResponse(response);
      if (managed && response.response_metadata.status === 'requires_action' && !response.tool_calls?.length) throw new Error('Antigravity requested action without pending tool calls.');
      if (!response.tool_calls?.length) throw new Error(managed ? `Antigravity selection ended with status ${response.response_metadata.status}. ${SELECTION_MISSING}` : SELECTION_MISSING);
      for (const call of response.tool_calls) {
        const previous = call.id ? handled.get(call.id) : undefined;
        if (previous && previous.name !== call.name) throw new Error(managed ? 'Antigravity reused a tool call ID for a different tool.' : 'The thinking model reused a tool call ID for a different tool.');
        // LangChain skips calls already answered in message history.
        if (previous) log.debug('tool.reused', { reason: 'duplicate-call-id', callId: call.id, name: call.name });
      }
      return response;
    },
    wrapToolCall: (request, handler) => {
      // LangChain dispatches a batch concurrently. Serialize handlers so
      // the first valid submission wins and later tools do no work.
      const result = queue.then(async () => {
        signal.throwIfAborted();
        const call = request.toolCall;
        if (toolFailed) return new ToolMessage({ content: 'Selection stopped after a tool failure.', status: 'error', tool_call_id: call.id!, name: call.name });
        if (getAccepted()) return new ToolMessage({ content: 'Selection already completed.', tool_call_id: call.id!, name: call.name });
        if (!call.id || !call.name) throw new Error('The thinking model returned an invalid tool call.');
        log.debug('tool.requested', { turn, call });
        const previous = handled.get(call.id!);
        if (previous) {
          if (previous.name !== call.name) throw new Error(managed ? 'Antigravity reused a tool call ID for a different tool.' : 'The thinking model reused a tool call ID for a different tool.');
          log.debug('tool.reused', { reason: 'duplicate-call-id', callId: call.id, name: call.name });
          return new ToolMessage({ name: previous.name, content: previous.content, status: previous.status, tool_call_id: call.id! });
        }
        let message: ToolMessage;
        try {
          if (!request.tool) throw new Error(`Unknown tool: ${call.name}`);
          const output = await handler(request);
          signal.throwIfAborted();
          if (!ToolMessage.isInstance(output)) throw new Error('Unexpected selection tool result.');
          message = output;
        } catch (error) {
          signal.throwIfAborted();
          log.warn('tool.rejected', { callId: call.id, name: call.name, error });
          message = new ToolMessage({ name: call.name, tool_call_id: call.id!, status: 'error',
            content: JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Tool execution failed.' } }) });
        }
        handled.set(call.id!, message);
        log.debug('tool.result', { callId: call.id, name: message.name, content: message.content, status: message.status });
        return message;
      });
      queue = result.then(() => undefined, () => { toolFailed = true; });
      return result;
    },
  });
}
