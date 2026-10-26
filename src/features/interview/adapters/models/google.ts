import { ChatGoogle } from '@langchain/google';
import type { ThinkingModelFactory } from '../../llm/types';
import { googleGroundedSearch } from '../search/googleGroundedSearch';

export const createGoogleModel: ThinkingModelFactory = config => {
  const llm = new ChatGoogle({ apiKey: config.apiKey, model: config.model, maxRetries: 0 });
  return {
    llm,
    capabilities: { structuredOutput: !!llm.profile?.structuredOutput, modelRetry: true, statefulContinuation: false },
    search: (query, systemPrompt, context) => googleGroundedSearch(llm, query, systemPrompt, context),
  };
};
