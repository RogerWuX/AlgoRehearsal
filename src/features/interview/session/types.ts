import type { InterviewApiConfig, ThinkingConfig } from '../../../shared/apiConfig';
import type { CodeSubmission } from '../judgment/model';
import type { JudgmentState } from '../judgment/state';
import type { StorageStatus } from '../../../shared/storage';
import type { Problem } from '../model/problem';
import type { ChatMessage } from '../model/chat';
export type { ChatMessage } from '../model/chat';

export type InterviewStatus = 'disconnected' | 'selecting' | 'connecting' | 'connected' | 'judging';

export type InterviewSnapshot = Readonly<{
  messages: readonly ChatMessage[];
  discussion: string;
  status: InterviewStatus;
  error: string;
  listening: boolean;
  problem: Problem | null;
  problemStorageStatus: StorageStatus;
  storedProblemCount: number;
  questionImportWarning: string;
  canRetry: boolean;
  judgment: JudgmentState;
  canResume: boolean;
  shouldResume: boolean;
  interviewStorageStatus: StorageStatus;
  recoveryWarning: string;
  recoveryNotice: string;
  audioNeedsInteraction: boolean;
}>;

export type InterviewActions = {
  connect(config: InterviewApiConfig): Promise<void>;
  retry(config: InterviewApiConfig): Promise<void>;
  endInterview(submission: CodeSubmission, thinkingConfig: ThinkingConfig): Promise<void>;
  retryJudgment(thinkingConfig: ThinkingConfig): Promise<void>;
  cancelJudgment(): void;
  disconnect(): void;
  quit(): void;
  send(text: string, options?: { kind: 'discussion' }): boolean;
  setDiscussion(text: string): void;
  toggleMic(): Promise<void>;
  configureRecovery(enabled: boolean): void;
  acknowledgeRecovery(): void;
  resume(config: InterviewApiConfig, automatic?: boolean): Promise<void>;
  enableAudio(): Promise<void>;
};

export type InterviewController = InterviewSnapshot & InterviewActions;
