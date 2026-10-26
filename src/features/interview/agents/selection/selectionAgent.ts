import { createAgent } from 'langchain/browser';
import { HumanMessage } from '@langchain/core/messages';
import type { ThinkingModel, ResolvedAgentContext } from '../../llm/types';
import type { Problem } from '../../model/problem';
import { createModelRetryMiddleware } from '../../llm/retry';
import { createSelectionTools, createSubmissionTools } from './tools';
import { selectionSystemPrompt, SEARCH_SYSTEM_PROMPT } from './prompts';
import { createSelectionMiddleware, SELECTION_MISSING } from './selectionMiddleware';

export async function runSelectionAgent(model: ThinkingModel, instructions: string, context: ResolvedAgentContext, problemSearchDescription = ''): Promise<Problem> {
  const log = context.logger, ctx = context;
  const managed = model.capabilities.statefulContinuation;
  let accepted: Problem | undefined, searchCalls = 0;
  const searchIds = new Set<string>(), urlIds = new Set<string>();
  const observe = (metadata: Record<string, unknown>) => {
    for (const step of (metadata.steps ?? []) as { type: string; id?: string }[]) {
      if (step.type === 'google_search_call' || step.type === 'url_context_call') {
        if (step.id) (step.type === 'google_search_call' ? searchIds : urlIds).add(step.id);
        log.debug('managed-search.observed', { interactionId: metadata.interactionId, step });
      }
    }
  };
  const scope = model.createRunScope?.(ctx, { logPayloads: true, onMetadata: observe });
  const submit = (problem: Problem) => { accepted = problem; };
  try {
    const tools = model.search ? createSelectionTools(async query => {
      log.debug('search.started', { query, searchCalls: ++searchCalls });
      const result = await model.search!(query, SEARCH_SYSTEM_PROMPT, ctx);
      context.signal.throwIfAborted();
      log.debug('search.result', { query, result });
      return result;
    }, submit) : createSubmissionTools(submit);
    const selection = createSelectionMiddleware({ log, signal: context.signal, getAccepted: () => accepted, managed,
      onResponse: response => { if (!scope) observe(response.response_metadata); },
    });
    const agent = createAgent({ model: model.llm, tools: [...tools, ...(model.serverSearchTools ?? [])],
      systemPrompt: selectionSystemPrompt(instructions, model.search ? 'client-search' : 'server-search'),
      middleware: [selection, ...(model.capabilities.modelRetry ? createModelRetryMiddleware(ctx) : []), ...(scope?.middleware ?? [])],
    });
    const description = problemSearchDescription.trim();
    const startMessage = description ? `Start problem selection.\n\nUser problem preferences:\n${description}` : 'Start problem selection.';
    await agent.invoke({ messages: [new HumanMessage(startMessage)] }, { signal: context.signal });
    context.signal.throwIfAborted();
    if (!accepted) throw new Error(SELECTION_MISSING);
    log.info('problem.accepted', { source: 'agent', providerPath: managed ? 'managed' : 'chat',
      searchObserved: managed ? searchIds.size > 0 : searchCalls > 0, searchCalls: managed ? searchIds.size : searchCalls,
      ...(managed ? { urlContextObserved: urlIds.size > 0, searchVisibility: 'returned-steps-only', urlContextCalls: urlIds.size } : {}), problem: accepted });
    return accepted;
  } finally { await scope?.dispose(); }
}
