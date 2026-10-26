import { normalizeLiveConfig, type LiveConfig } from '../../../shared/apiConfig';
import type { StorageStatus } from '../../../shared/storage';
import { validateAssessment } from '../judgment/model';
import { emptyJudgment, type JudgmentState } from '../judgment/state';
import { validateProblem, type Problem } from '../model/problem';
import type { ChatMessage } from '../session/types';

export const INTERVIEW_STORAGE_KEY = 'interview-practice.interview';
export type SavedInterview = {
  version: 1;
  lifecycle: 'idle' | 'selecting' | 'active' | 'paused' | 'ended';
  problem: Problem | null;
  messages: readonly ChatMessage[];
  discussion: string;
  live: Omit<LiveConfig, 'credential'> | null;
  resumptionHandle: string | null;
  judgment: JudgmentState;
};
export interface InterviewStateRepository {
  read(): { value: SavedInterview | null; storageStatus: StorageStatus; warning: string };
  write(value: SavedInterview): StorageStatus;
  clear(): StorageStatus;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved interview.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid saved interview.');
  return value;
}
function messages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) throw new Error('Invalid saved discussion.');
  const ids = new Set<number>();
  return value.map(item => {
    const entry = record(item);
    if (typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id) || entry.id < 1 || ids.has(entry.id)
      || (entry.role !== 'user' && entry.role !== 'model')) throw new Error('Invalid saved discussion.');
    ids.add(entry.id);
    if (entry.kind !== undefined && (entry.kind !== 'discussion' || entry.role !== 'user')) throw new Error('Invalid saved discussion.');
    return { id: entry.id, role: entry.role, text: text(entry.text), ...(entry.kind === 'discussion' ? { kind: entry.kind } : {}) };
  });
}

function judgment(value: unknown): JudgmentState {
  const entry = record(value);
  if (!['idle', 'running', 'completed', 'failed', 'canceled'].includes(text(entry.status))) throw new Error('Invalid saved grading.');
  const result = emptyJudgment();
  result.status = entry.status as JudgmentState['status'];
  if (entry.phase !== null && entry.phase !== 'code' && entry.phase !== 'interview') throw new Error('Invalid saved grading.');
  result.phase = entry.phase;
  if (entry.submission !== null) {
    const submission = record(entry.submission);
    result.submission = { code: text(submission.code), language: text(submission.language),
      discussion: text(submission.discussion),
      problem: validateProblem(submission.problem), messages: messages(submission.messages), submittedAt: text(submission.submittedAt) };
    if (!Number.isFinite(Date.parse(result.submission.submittedAt))) throw new Error('Invalid saved grading.');
  }
  result.code = entry.code === null ? null : validateAssessment('code', entry.code);
  result.interview = entry.interview === null ? null : validateAssessment('interview', entry.interview);
  const errors = record(entry.errors);
  for (const kind of ['code', 'interview'] as const) if (errors[kind] !== undefined) result.errors[kind] = text(errors[kind]);
  if (result.status !== 'idle' && !result.submission) throw new Error('Invalid saved grading.');
  return result;
}

// Copy a whitelist on both read and write; credentials cannot become snapshot fields.
export function validateSavedInterview(value: unknown): SavedInterview {
  const entry = record(value);
  if (entry.version !== 1 || !['idle', 'selecting', 'active', 'paused', 'ended'].includes(text(entry.lifecycle))) throw new Error('Invalid saved interview.');
  const problem = entry.problem === null ? null : validateProblem(entry.problem);
  let live: SavedInterview['live'] = null;
  if (entry.live !== null) {
    const config = record(entry.live);
    const normalized = normalizeLiveConfig({ credential: '', model: text(config.model), thinkingEffort: typeof config.thinkingEffort === 'string' ? config.thinkingEffort : undefined });
    if (!normalized.model) throw new Error('Invalid saved Live configuration.');
    live = { model: normalized.model, ...(normalized.thinkingEffort !== undefined ? { thinkingEffort: normalized.thinkingEffort } : {}) };
  }
  if ((entry.lifecycle === 'active' || entry.lifecycle === 'paused') && (!problem || !live)) throw new Error('Invalid saved interview.');
  return { version: 1, lifecycle: entry.lifecycle as SavedInterview['lifecycle'], problem, live,
    discussion: text(entry.discussion),
    messages: messages(entry.messages), resumptionHandle: entry.resumptionHandle === null ? null : text(entry.resumptionHandle),
    judgment: judgment(entry.judgment) };
}

export function createInterviewStateRepository(getStorage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): InterviewStateRepository {
  return {
    read() {
      try {
        const storage = getStorage();
        if (!storage) return { value: null, storageStatus: 'session', warning: '' };
        const raw = storage.getItem(INTERVIEW_STORAGE_KEY);
        if (!raw) return { value: null, storageStatus: 'saved', warning: '' };
        try { return { value: validateSavedInterview(JSON.parse(raw)), storageStatus: 'saved', warning: '' }; }
        catch { return { value: null, storageStatus: 'saved', warning: 'Saved interview progress could not be restored.' }; }
      } catch { return { value: null, storageStatus: 'unavailable', warning: 'Interview storage is unavailable. Progress is kept for this session only.' }; }
    },
    write(value) {
      try {
        const storage = getStorage();
        if (!storage) return 'session';
        storage.setItem(INTERVIEW_STORAGE_KEY, JSON.stringify(validateSavedInterview(value)));
        return 'saved';
      } catch { return 'unavailable'; }
    },
    clear() {
      try {
        const storage = getStorage();
        if (!storage) return 'session';
        storage.removeItem(INTERVIEW_STORAGE_KEY);
        return 'saved';
      } catch { return 'unavailable'; }
    },
  };
}
