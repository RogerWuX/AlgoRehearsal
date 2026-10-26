import { logger as appLogger, type Logger } from '../../../shared/logger';
import { loadSelectionInstructions } from '../agents/selection/loadSelectionInstructions';
import { selectProblem as selectAgentProblem } from '../agents/selection/selectProblem';
import { invokeWithSignal } from '../llm/invokeWithSignal';
import type { ThinkingModel, ThinkingRuntime } from '../llm/types';
import { validateProblem, type Problem } from '../model/problem';
import { generateRandomNumber } from '../utils';
import type { ProblemRepository, ProblemSelector } from './types';

export function createProblemSelector(dependencies: {
  problems: ProblemRepository;
  thinking: ThinkingRuntime;
  loadInstructions?(signal: AbortSignal): Promise<string>;
  selectProblem?(model: ThinkingModel, instructions: string, signal: AbortSignal, logger: Logger, problemSearchDescription?: string): Promise<Problem>;
}): ProblemSelector {
  const { problems, thinking, loadInstructions = loadSelectionInstructions, selectProblem = selectAgentProblem } = dependencies;
  return {
    getBankInfo: () => ({ storedProblemCount: problems.list().length, questionImportWarning: problems.importWarning }),
    prepare(config, logger = appLogger) {
      const source = config.problemSource;
      const saveSearchedProblems = config.saveSearchedProblems;
      const problemSearchDescription = config.problemSearchDescription.trim();
      const thinkingConfig = { ...config.thinking };
      const storedProblems = source === 'stored' ? [...problems.list()] : [];
      if (source === 'stored' && !storedProblems.length) {
        logger.warn('session.start-rejected', { reason: 'stored-bank-empty', fallbackToAgent: false });
        throw new Error('No stored questions are available. Add questions to question/questions.json or uncheck Use stored questions to select a new problem.');
      }
      return {
        initialStatus: source === 'stored' ? 'connecting' : 'selecting',
        logContext: { source, saveSearchedProblems, storedProblemCount: storedProblems.length },
        async getProblem(signal, log) {
          signal.throwIfAborted();
          let problem: Problem;
          if (source === 'stored') {
            const index = generateRandomNumber({ min: 0, max: storedProblems.length - 1 });
            problem = validateProblem(storedProblems[index]);
            log.info('problem.loaded', { source: 'stored-bank', origin: problems.getOrigin?.(problem.sourceUrl) ?? 'unknown',
              index, bankSize: storedProblems.length, selectionSkipped: true, problem });
          } else {
            log.debug('instructions.load-started', { source: 'embedded-selection-prompt' });
            const instructions = await invokeWithSignal(() => loadInstructions(signal), signal);
            signal.throwIfAborted();
            log.debug('instructions.loaded', { instructions });
            const model = thinking.getModel(thinkingConfig);
            const selected = await invokeWithSignal(() => selectProblem(model, instructions, signal, log, problemSearchDescription), signal);
            signal.throwIfAborted();
            problem = validateProblem(selected);
            log.info('problem.loaded', { source: 'agent', problem });
          }
          signal.throwIfAborted();
          const problemStorageStatus = source === 'stored' || saveSearchedProblems ? problems.write(problem, log) : 'session';
          if (source !== 'stored' && !saveSearchedProblems) log.info('problem.session-only', { reason: 'saving-disabled', sourceUrl: problem.sourceUrl });
          return { problem, problemStorageStatus, storedProblemCount: problems.list().length };
        },
      };
    },
  };
}
