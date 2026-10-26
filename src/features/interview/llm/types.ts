import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentMiddleware } from 'langchain/browser';
import type { ThinkingConfig, ResolvedThinkingConfig } from '../../../shared/apiConfig';
import type { Logger } from '../../../shared/logger';

export type SearchResult = { text: string; sources: { title: string; url: string }[] };
export type AgentContext = { signal: AbortSignal; logger?: Logger };
export type ResolvedAgentContext = AgentContext & { logger: Logger };
export type ModelRunOptions = { logPayloads: boolean; onMetadata?(metadata: Record<string, unknown>): void };
export type ModelRunScope = { middleware: AgentMiddleware[]; dispose(): Promise<void> };
export type ThinkingModelDefinition = {
  readonly llm: BaseChatModel;
  readonly search?: (query: string, systemPrompt: string, ctx: ResolvedAgentContext) => Promise<SearchResult>;
  readonly serverSearchTools?: readonly Record<string, unknown>[];
  readonly capabilities: { structuredOutput: boolean; modelRetry: boolean; statefulContinuation: boolean };
  createRunScope?(context: ResolvedAgentContext, options: ModelRunOptions): ModelRunScope;
};
export type ThinkingModel = ThinkingModelDefinition & {
  readonly modelId: string;
  readonly provider: string;
  getLogger(logger?: Logger): Logger;
};
// Factories construct library models; the runtime supplies identity and logging.
export type ThinkingModelFactory = (config: ResolvedThinkingConfig) => ThinkingModelDefinition;
export type ThinkingRuntime = { getModel(config: ThinkingConfig): ThinkingModel };
