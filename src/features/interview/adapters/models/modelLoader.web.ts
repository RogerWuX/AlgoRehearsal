// Metro maps LangChain's dynamic provider loader here. Model factories supply
// constructed LLMs; loading optional provider packages by name is unsupported.
export async function initChatModel(): Promise<never> {
  throw new Error('Pass a constructed LangChain model from adapters/models to the agent. Model-name loading is unavailable in Metro.');
}
