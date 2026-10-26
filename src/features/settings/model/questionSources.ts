import type { ProblemSource } from '../../../shared/apiConfig';

export const questionSources: readonly { value: ProblemSource; label: string }[] = [
  { value: 'stored', label: 'Local questions' },
  { value: 'agent', label: 'Web search' },
];
