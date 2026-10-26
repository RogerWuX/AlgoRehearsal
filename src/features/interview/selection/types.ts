import type { InterviewApiConfig, ProblemSource } from '../../../shared/apiConfig';
import type { Logger } from '../../../shared/logger';
import type { StorageStatus } from '../../../shared/storage';
import type { Problem } from '../model/problem';

export type ProblemOrigin = 'project-json' | 'local-storage' | 'session' | 'unknown';
export interface ProblemRepository {
  read(): { problem: Problem | null; problemStorageStatus: StorageStatus };
  list(): readonly Problem[];
  readonly importWarning: string;
  write(problem: Problem, logger?: Logger): StorageStatus;
  getOrigin?(sourceUrl: string): ProblemOrigin;
}

export type ProblemSelectionConfig = Pick<InterviewApiConfig, 'thinking' | 'problemSource' | 'problemSearchDescription' | 'saveSearchedProblems'>;
export type ProblemSelectionResult = {
  problem: Problem;
  problemStorageStatus: StorageStatus;
  storedProblemCount: number;
};
export type PreparedProblemSelection = {
  initialStatus: 'selecting' | 'connecting';
  logContext: { source: ProblemSource; saveSearchedProblems: boolean; storedProblemCount: number };
  getProblem(signal: AbortSignal, logger: Logger): Promise<ProblemSelectionResult>;
};
export interface ProblemSelector {
  getBankInfo(): { storedProblemCount: number; questionImportWarning: string };
  prepare(config: ProblemSelectionConfig, logger?: Logger): PreparedProblemSelection;
}
