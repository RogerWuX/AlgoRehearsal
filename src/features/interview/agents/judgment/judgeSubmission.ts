import { invokeWithSignal } from '../../llm/invokeWithSignal';
import { runJudgmentAgent } from './judgmentAgent';
import { logger as appLogger, type Logger } from '../../../../shared/logger';
import type { Assessment, JudgmentRequest } from '../../judgment/model';
import type { ThinkingModel } from '../../llm/types';

export async function judgeSubmission(model: ThinkingModel, request: JudgmentRequest, signal: AbortSignal, logger: Logger = appLogger): Promise<Assessment> {
  signal.throwIfAborted();
  const log = model.getLogger(logger).child({ scope: 'judgment-provider', kind: request.kind });
  return invokeWithSignal(() => runJudgmentAgent(model, request, { signal, logger: log }), signal);
}
