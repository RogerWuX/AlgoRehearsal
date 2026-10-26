import type { ThinkingConfig } from '../../../shared/apiConfig';
import { logger as appLogger, type Logger } from '../../../shared/logger';
import { judgeSubmission } from '../agents/judgment/judgeSubmission';
import { invokeWithSignal } from '../llm/invokeWithSignal';
import type { ThinkingModel, ThinkingRuntime } from '../llm/types';
import { systemClock, type Clock } from '../utils';
import { validateAssessment, type JudgmentRequest } from './model';
import { freezeJudgment, interruptJudgment, type JudgmentState } from './state';
import type { JudgeSubmission, JudgmentContext, JudgmentWorkflow } from './types';

export const JUDGMENT_TIMEOUT_MS = 300000;

type Operation = {
  controller: AbortController;
  state: JudgmentState;
  context: JudgmentContext;
  logger: Logger;
  timeout: unknown;
};

function errorMessage(error: unknown, fallback: string, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : fallback;
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

export function createJudgmentWorkflow(dependencies: {
  thinking: ThinkingRuntime;
  judge?: JudgeSubmission;
  clock?: Clock;
}): JudgmentWorkflow {
  const { thinking, judge = judgeSubmission, clock = systemClock } = dependencies;
  let operation: Operation | null = null;

  const publish = (active: Operation, change: Partial<JudgmentState>) => {
    active.state = freezeJudgment({ ...active.state, ...change });
    active.context.onChange(active.state);
  };
  const clearTimeout = (active: Operation) => {
    if (active.timeout !== null) clock.clearTimeout(active.timeout);
    active.timeout = null;
  };

  return {
    isRunning: () => operation !== null,
    cancel() {
      if (!operation) return;
      const active = operation;
      operation = null;
      active.controller.abort();
      clearTimeout(active);
      active.state = interruptJudgment(active.state, 'Judgment canceled. Retry to finish.');
      active.context.onChange(active.state);
      active.logger.info('judgment.canceled');
    },
    async run(previousState, requestedConfig, context) {
      if (operation || !previousState.submission || (previousState.code && previousState.interview)) return;
      const config: ThinkingConfig = { ...requestedConfig };
      const secrets = [...(context.secrets ?? []), config.apiKey.trim()];
      const active: Operation = {
        controller: new AbortController(), state: freezeJudgment({ ...previousState, errors: { ...previousState.errors } }),
        context, logger: context.logger ?? appLogger, timeout: null,
      };
      operation = active;
      const current = () => operation === active && !active.controller.signal.aborted;
      const submission = previousState.submission;
      let model: ThinkingModel;
      try {
        model = thinking.getModel(config);
      } catch (error) {
        const message = errorMessage(error, 'The Thinking configuration is invalid.', secrets);
        const errors = { ...active.state.errors };
        for (const kind of ['code', 'interview'] as const) if (!active.state[kind]) errors[kind] = message;
        operation = null;
        publish(active, { status: 'failed', errors });
        return;
      }
      const log = active.logger.child({ scope: 'judgment', model: config.model.trim() }, [config.apiKey]);
      publish(active, { status: 'running' });
      for (const kind of ['code', 'interview'] as const) {
        if (!current()) return;
        if (active.state[kind]) continue;
        const phase = new AbortController();
        const onAbort = () => phase.abort(active.controller.signal.reason);
        active.controller.signal.addEventListener('abort', onAbort, { once: true });
        active.timeout = clock.setTimeout(() => phase.abort(new Error(`${kind === 'code' ? 'Code' : 'Interview'} judgment timed out. Retry this judgment.`)), JUDGMENT_TIMEOUT_MS);
        const errors = { ...active.state.errors };
        delete errors[kind];
        try {
          publish(active, { phase: kind, errors });
          if (!current()) return;
          log.info('judgment.started', { kind, characters: kind === 'code' ? submission.code.length : undefined,
            messages: kind === 'interview' ? submission.messages.length : undefined });
          const request: JudgmentRequest = kind === 'code'
            ? { kind, problem: submission.problem, code: submission.code, language: submission.language }
            : { kind, problem: submission.problem, messages: submission.messages, discussion: submission.discussion };
          const result = await invokeWithSignal(() => judge(model, request, phase.signal, log), phase.signal);
          if (!current()) return;
          publish(active, { [kind]: validateAssessment(kind, result) });
          log.info('judgment.completed', { kind });
        } catch (error) {
          if (!current()) return;
          const message = errorMessage(error, 'The judgment failed. Check Thinking settings and retry.', secrets);
          publish(active, { errors: { ...active.state.errors, [kind]: message } });
          log.warn('judgment.failed', { kind, reason: phase.signal.aborted ? 'timeout' : 'provider-or-validation-error' });
        } finally {
          clearTimeout(active);
          active.controller.signal.removeEventListener('abort', onAbort);
        }
      }
      if (!current()) return;
      operation = null;
      publish(active, { phase: null, status: active.state.code && active.state.interview ? 'completed' : 'failed' });
    },
  };
}
