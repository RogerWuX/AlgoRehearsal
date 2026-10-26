import { validateProblem, type Problem } from '../model/problem';
import type { KeyValueStorage, StorageStatus } from '../../../shared/storage';
import type { ProblemRepository, ProblemOrigin } from '../selection/types';
import { logger as appLogger, type Logger } from '../../../shared/logger';

export const PROBLEM_STORAGE_KEY = 'interview-practice.problem';
export const PROBLEM_BANK_STORAGE_KEY = 'interview-practice.questions';

export function parseProblemBank(raw: string): { problems: Problem[]; invalid: boolean } {
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return { problems: [], invalid: true };
    const problems: Problem[] = [];
    let invalid = false;
    for (const entry of entries) {
      try { problems.push(validateProblem(entry)); } catch { invalid = true; }
    }
    return { problems, invalid };
  } catch { return { problems: [], invalid: true }; }
}

export function readProblem(storage: Pick<KeyValueStorage, 'getItem'>): Problem | null {
  const raw = storage.getItem(PROBLEM_STORAGE_KEY);
  if (!raw) return null;
  try { return validateProblem(JSON.parse(raw)); } catch { return null; }
}

export function writeProblem(storage: Pick<KeyValueStorage, 'setItem'>, problem: Problem) {
  storage.setItem(PROBLEM_STORAGE_KEY, JSON.stringify(validateProblem(problem)));
}

export function createProblemRepository(getStorage: () => KeyValueStorage | null, options: {
  initialProblems?: readonly Problem[];
  importWarning?: string;
  logger?: Logger;
} = {}): ProblemRepository {
  const log = (options.logger ?? appLogger).child({ scope: 'problem-storage' });
  const bank = new Map<string, Problem>();
  const origins = new Map<string, ProblemOrigin>();
  let problem: Problem | null = null;
  let problemStorageStatus: StorageStatus = 'session';
  let storage: KeyValueStorage | null = null;
  let rawBank: string | null = null;
  try {
    storage = getStorage();
    if (storage) {
      problemStorageStatus = 'saved';
      rawBank = storage.getItem(PROBLEM_BANK_STORAGE_KEY);
      const parsed = parseProblemBank(rawBank ?? '[]');
      if (parsed.invalid) log.warn('bank.invalid-records', { source: 'local-storage', reason: 'invalid-json-or-problem' });
      for (const entry of parsed.problems) {
        bank.set(entry.sourceUrl, entry);
        origins.set(entry.sourceUrl, 'local-storage');
      }
      log.debug('bank.loaded', { source: 'local-storage', count: bank.size });
      problem = readProblem(storage);
      if (problem) log.info('problem.restored', { source: 'local-storage', problem });
      else log.debug('problem.restore-empty', { source: 'local-storage', reason: 'missing-or-invalid-active-problem' });
    }
    else log.debug('storage.session-only', { reason: 'storage-not-available' });
  } catch (error) {
    problemStorageStatus = 'unavailable';
    log.warn('storage.read-failed', { error, fallback: 'session' });
  }

  if (problem) {
    bank.set(problem.sourceUrl, problem);
    origins.set(problem.sourceUrl, 'local-storage');
  }
  for (const entry of options.initialProblems ?? []) {
    const accepted = validateProblem(entry);
    log.debug('bank.project-import', { path: 'question/questions.json', sourceUrl: accepted.sourceUrl,
      title: accepted.title, replacesExisting: bank.has(accepted.sourceUrl) });
    bank.set(accepted.sourceUrl, accepted);
    origins.set(accepted.sourceUrl, 'project-json');
  }
  try {
    if (storage) {
      if (bank.size && rawBank !== JSON.stringify([...bank.values()])) {
        storage.setItem(PROBLEM_BANK_STORAGE_KEY, JSON.stringify([...bank.values()]));
      }
    }
  } catch (error) {
    problemStorageStatus = 'unavailable';
    log.warn('storage.import-save-failed', { error, fallback: 'session' });
  }
  if (options.importWarning) log.warn('bank.import-warning', { warning: options.importWarning });
  log.info('bank.ready', { count: bank.size, problemStorageStatus });

  return {
    read: () => ({ problem, problemStorageStatus }),
    list: () => [...bank.values()],
    getOrigin: sourceUrl => origins.get(sourceUrl) ?? 'unknown',
    importWarning: options.importWarning ?? '',
    write: (next, logger = log) => {
      const writeLog = logger.child({ scope: 'problem-storage' });
      const accepted = validateProblem(next);
      const previous = bank.get(accepted.sourceUrl);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(accepted)) origins.set(accepted.sourceUrl, 'session');
      problem = accepted;
      bank.set(accepted.sourceUrl, accepted);
      try {
        const storage = getStorage();
        if (!storage) problemStorageStatus = 'session';
        else {
          storage.setItem(PROBLEM_BANK_STORAGE_KEY, JSON.stringify([...bank.values()]));
          writeProblem(storage, accepted);
          problemStorageStatus = 'saved';
        }
      } catch (error) {
        problemStorageStatus = 'unavailable';
        writeLog.warn('storage.write-failed', { error, fallback: 'session' });
      }
      writeLog.info('problem.persisted', { sourceUrl: accepted.sourceUrl, title: accepted.title, problemStorageStatus, count: bank.size });
      return problemStorageStatus;
    },
  };
}
