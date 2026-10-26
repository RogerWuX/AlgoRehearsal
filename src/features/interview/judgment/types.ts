import type { ThinkingConfig } from '../../../shared/apiConfig';
import type { Logger } from '../../../shared/logger';
import type { ThinkingModel } from '../llm/types';
import type { Assessment, JudgmentRequest } from './model';
import type { JudgmentState } from './state';

export type JudgeSubmission = (model: ThinkingModel, request: JudgmentRequest, signal: AbortSignal, logger?: Logger) => Promise<Assessment>;

export type JudgmentContext = {
  onChange(state: JudgmentState): void;
  logger?: Logger;
  secrets?: readonly string[];
};

export interface JudgmentWorkflow {
  run(previousState: JudgmentState, config: ThinkingConfig, context: JudgmentContext): Promise<void>;
  cancel(): void;
  isRunning(): boolean;
}
