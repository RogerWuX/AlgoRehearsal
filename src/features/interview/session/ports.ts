import type { LiveConfig } from '../../../shared/apiConfig';
import type { Problem } from '../model/problem';
import type { Logger } from '../../../shared/logger';
import type { JudgmentWorkflow } from '../judgment/types';
import type { InterviewTransport, TransportEvents, TransportRecovery, InterviewAudio } from '../model/transport';
import type { InterviewStateRepository } from '../storage/interviewStateStorage';
import type { ProblemSelector } from '../selection/types';
import type { Clock as SessionClock } from '../utils';

export type { AudioChunk, InterviewContent, InterviewTransport, TransportEvents, TransportRecovery, InterviewAudio } from '../model/transport';

export type { Clock as SessionClock } from '../utils';

export type SessionDependencies = {
  selection: ProblemSelector;
  judgment: JudgmentWorkflow;
  interviewState?: InterviewStateRepository;
  formatDiscussionMessage(text: string): string;
  createTransport(config: LiveConfig, problem: Problem, events: TransportEvents, logger?: Logger, recovery?: TransportRecovery): InterviewTransport;
  createAudio(logger?: Logger): InterviewAudio;
  clock?: SessionClock;
  logger?: Logger;
};
