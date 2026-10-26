import { createAgent, providerStrategy, toolStrategy, StructuredOutputParsingError, MultipleStructuredOutputsError } from 'langchain/browser';
import { HumanMessage } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { ThinkingModel, ResolvedAgentContext } from '../../llm/types';
import { createModelRetryMiddleware } from '../../llm/retry';
import { assessmentSchema, validateAssessment, type Assessment, type JudgmentRequest } from '../../judgment/model';
import { judgmentPrompt } from './prompts';

export async function runJudgmentAgent(model: ThinkingModel, request: JudgmentRequest, context: ResolvedAgentContext): Promise<Assessment> {
  const ctx = context;
  const scope = model.createRunScope?.(ctx, { logPayloads: false });
  try {
    const schema = assessmentSchema(request.kind);
    const options = { model: model.llm, tools: [], systemPrompt: judgmentPrompt(request),
      middleware: [...(model.capabilities.modelRetry ? createModelRetryMiddleware(ctx) : []), ...(scope?.middleware ?? [])] };
    const responseFormat = model.capabilities.structuredOutput
      ? providerStrategy(schema)
      : toolStrategy({ ...toJsonSchema(schema), title: 'submit_assessment',
          description: 'Submit the completed written assessment.' } as { type: 'object'; [key: string]: unknown }, { handleError: false })[0];
    const agent = createAgent({ ...options, responseFormat });
    const response = await agent.invoke({ messages: [new HumanMessage(JSON.stringify(request))] }, { signal: context.signal });
    context.signal.throwIfAborted();
    if (!response.structuredResponse) throw new Error('The judge finished without submitting an assessment. Retry this judgment.');
    return validateAssessment(request.kind, response.structuredResponse);
  } catch (error) {
    const cause = unwrapError(error);
    if (cause instanceof StructuredOutputParsingError || cause instanceof MultipleStructuredOutputsError) {
      throw new Error('The judge returned an invalid assessment. Retry this judgment.');
    }
    throw error;
  } finally { await scope?.dispose(); }
}

function unwrapError(error: unknown): unknown {
  const seen = new Set<unknown>();
  while (error instanceof Error && 'cause' in error && error.cause && !seen.has(error)) {
    seen.add(error);
    error = error.cause;
  }
  return error;
}
