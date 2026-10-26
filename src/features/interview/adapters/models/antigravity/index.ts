import type { ThinkingModelFactory } from '../../../llm/types';
import { ChatAntigravity } from './ChatAntigravity.web';
export { ANTIGRAVITY_POLL_INTERVAL_MS } from './polling';

export const createAntigravityModel: ThinkingModelFactory = config => {
  const llm = new ChatAntigravity({ apiKey: config.apiKey, agent: config.model });
  return {
    llm, serverSearchTools: [{ type: 'google_search' }, { type: 'url_context' }],
    capabilities: { structuredOutput: false, modelRetry: false, statefulContinuation: true },
    createRunScope: (context, options) => llm.createRunScope(context, options),
  };
};
