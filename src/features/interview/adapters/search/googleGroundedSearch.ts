import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ResolvedAgentContext, SearchResult } from '../../llm/types';
import { invokeModelWithRetry } from '../../llm/retry';

export async function googleGroundedSearch(llm: BaseChatModel, query: string, systemPrompt: string, context: ResolvedAgentContext): Promise<SearchResult> {
  const { signal } = context, log = context.logger.child({ scope: 'google-search' });
  signal.throwIfAborted();
  log.debug('search.llm-request', { query });
  const response = await invokeModelWithRetry(llm.bindTools!([{ googleSearch: {} }]),
    [new SystemMessage(systemPrompt), new HumanMessage(query)], context);
  log.debug('search.llm-response', { query, response });
  signal.throwIfAborted();
  const text = response?.text ?? '';
  if (!text.trim()) throw new Error('Problem search returned no usable results.');
  const metadata = (response?.response_metadata.grounding_metadata ?? response?.response_metadata.groundingMetadata) as {
    groundingChunks?: { web?: { uri?: string; title?: string } }[];
  } | undefined;
  const sources: SearchResult['sources'] = [];
  for (const chunk of Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : []) {
    if (typeof chunk.web?.uri === 'string') sources.push({ title: typeof chunk.web.title === 'string' ? chunk.web.title : chunk.web.uri, url: chunk.web.uri });
  }
  log.debug('search.sources', { query, sources });
  return { text, sources };
}
