import { invokeWithSignal } from '../../llm/invokeWithSignal';
import { runSelectionAgent } from './selectionAgent';
import type { Problem } from '../../model/problem';
import type { ThinkingModel } from '../../llm/types';
import { logger as appLogger, type Logger } from '../../../../shared/logger';

export async function selectProblem(model: ThinkingModel, instructions: string, signal: AbortSignal, logger: Logger = appLogger, problemSearchDescription = ''): Promise<Problem> {
  const log = model.getLogger(logger).child({ scope: 'selection' });
  log.info('selection.started');
  log.debug('selection.instructions', { instructions });
  try {
    return await invokeWithSignal(() => runSelectionAgent(model, instructions, { signal, logger: log }, problemSearchDescription), signal);
  } catch (error) {
    if (signal.aborted) log.info('selection.canceled', { reason: signal.reason });
    else log.error('selection.failed', { error });
    throw error;
  }
}
