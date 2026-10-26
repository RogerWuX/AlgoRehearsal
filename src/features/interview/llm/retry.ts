import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMiddleware, modelRetryMiddleware } from 'langchain/browser';
import { getRetryable } from '@langchain/core/errors';
import type { ResolvedAgentContext } from './types';

export const MODEL_RETRY_POLICY = {
  maxRetries: 2, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000, jitter: true, onFailure: 'error',
} as const;

export function shouldRetryModelError(error: Error): boolean {
  if (error.name === 'AbortError') return false;
  const marked = getRetryable(error);
  if (marked !== undefined) return marked;
  const details = error as Error & { status?: number; statusCode?: number; code?: string | number; cause?: { code?: string } };
  const status = details.status ?? details.statusCode ?? (typeof details.code === 'number' ? details.code : undefined);
  if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status < 600);
  return ['NetworkError', 'TimeoutError'].includes(error.name)
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(details.cause?.code ?? String(details.code ?? ''))
    || (error.name === 'TypeError' && /^(Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.|Load failed)$/.test(error.message));
}

export function createModelRetryMiddleware({ signal, logger }: ResolvedAgentContext) {
  let attempt = 0;
  const retry = modelRetryMiddleware({ ...MODEL_RETRY_POLICY, retryOn: error => !signal.aborted && shouldRetryModelError(error) });
  return [createMiddleware({
      name: 'InterviewModelRetry',
      contextSchema: retry.contextSchema,
      // Guard the handler inside the built-in retry hook. A separate inner
      // middleware would wrap errors and hide retryability/Retry-After metadata.
      wrapModelCall: (request, handler) => retry.wrapModelCall!(request, async next => {
        signal.throwIfAborted();
        const id = ++attempt, startedAt = Date.now();
        logger.debug('request.started', { attempt: id });
        try {
          const response = await handler(next);
          signal.throwIfAborted();
          logger.debug('request.completed', { attempt: id, durationMs: Date.now() - startedAt });
          return response;
        } catch (error) {
          // Errors can contain judgment inputs and API keys: log progress only.
          logger.warn('request.failed', { attempt: id, durationMs: Date.now() - startedAt,
            retryable: !signal.aborted && error instanceof Error && shouldRetryModelError(error) });
          throw error;
        }
      }),
    })] as const;
}

// Reuse the middleware policy for a single grounded SDK call without a graph.
export async function invokeModelWithRetry(model: ReturnType<NonNullable<BaseChatModel['bindTools']>>, messages: BaseMessage[], context: ResolvedAgentContext) {
  const [retry] = createModelRetryMiddleware(context);
  const result = await retry.wrapModelCall!({ model, messages, systemPrompt: '', systemMessage: new SystemMessage(''), tools: [],
    state: { messages }, runtime: { signal: context.signal, context: { ...MODEL_RETRY_POLICY, retryOn: shouldRetryModelError } } }, () => model.invoke(messages, { signal: context.signal }));
  if (!AIMessage.isInstance(result)) throw new Error('Unexpected model result.');
  return result;
}
