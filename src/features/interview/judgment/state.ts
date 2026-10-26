import type { ChatMessage } from '../model/chat';
import type { Problem } from '../model/problem';
import type { Assessment, CodeSubmission, InterviewSubmission, JudgmentKind } from './model';

export type JudgmentState = {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'canceled';
  phase: JudgmentKind | null;
  submission: InterviewSubmission | null;
  code: Assessment | null;
  interview: Assessment | null;
  errors: Partial<Record<JudgmentKind, string>>;
};
export const emptyJudgment = (): JudgmentState => ({
  status: 'idle', phase: null, submission: null, code: null, interview: null, errors: {},
});

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function freezeJudgment(state: JudgmentState): JudgmentState {
  return freeze(state);
}

export function captureSubmission(problem: Problem, messages: readonly ChatMessage[], submission: CodeSubmission, discussion: string): InterviewSubmission {
  return freeze({
    ...submission,
    discussion,
    problem: JSON.parse(JSON.stringify(problem)) as Problem,
    messages: messages.map(message => ({ ...message })),
    submittedAt: new Date().toISOString(),
  });
}

export function interruptJudgment(state: JudgmentState, message: string): JudgmentState {
  const errors = { ...state.errors };
  for (const kind of ['code', 'interview'] as const) {
    if (!state[kind]) errors[kind] = message;
  }
  return freezeJudgment({ ...state, status: 'canceled', phase: null, errors });
}

export function restoreJudgment(state: JudgmentState): JudgmentState {
  return state.status === 'running'
    ? interruptJudgment(state, 'Grading was interrupted. Retry to finish.')
    : freezeJudgment(state);
}

