import interviewerInstruction from './interviewer.md';

export const INTERVIEW_INSTRUCTION = interviewerInstruction.trim();

export const DISCUSSION_MARKER = '[Discussion notes]';

export function formatDiscussionMessage(text: string): string {
  return `${DISCUSSION_MARKER}\n${text}`;
}
