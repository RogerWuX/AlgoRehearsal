import { CODE_PERSPECTIVES, INTERVIEW_PERSPECTIVES, type JudgmentRequest } from '../../judgment/model';
import judgmentTemplate from './judgment.md';
import { renderPrompt } from '../renderPrompt';

export function judgmentPrompt(request: JudgmentRequest): string {
  const dimensions = request.kind === 'code' ? CODE_PERSPECTIVES : INTERVIEW_PERSPECTIVES;
  return renderPrompt(judgmentTemplate, { kind: request.kind, perspectives: dimensions.join('; ') }, {
    code: request.kind === 'code', interview: request.kind === 'interview',
  });
}
