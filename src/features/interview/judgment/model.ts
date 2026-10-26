import { z } from 'zod';
import type { Problem } from '../model/problem';
import type { ChatMessage } from '../model/chat';

export const CODE_PERSPECTIVES = ['Correctness', 'Time and space complexity', 'Code quality', 'Edge cases and testing'] as const;
export const INTERVIEW_PERSPECTIVES = ['Problem understanding', 'Algorithmic reasoning', 'Communication', 'Testing discussion', 'Complexity and tradeoffs'] as const;
export type JudgmentKind = 'code' | 'interview';
export type CodeSubmission = { code: string; language: string };
export type JudgmentRequest = { kind: 'code'; problem: Problem; code: string; language: string }
  | { kind: 'interview'; problem: Problem; messages: readonly ChatMessage[]; discussion: string };
export type Assessment = {
  summary: string;
  perspectives: { perspective: string; feedback: string }[];
  strengths: string[];
  improvements: string[];
};
export type InterviewSubmission = CodeSubmission & {
  discussion: string;
  problem: Problem;
  messages: readonly ChatMessage[];
  submittedAt: string;
};

export function assessmentSchema(kind: JudgmentKind) {
  const perspectives = kind === 'code' ? CODE_PERSPECTIVES : INTERVIEW_PERSPECTIVES;
  const text = z.string().trim().min(1);
  return z.object({
    summary: text,
    perspectives: z.array(z.object({ perspective: z.enum(perspectives), feedback: text }).strict()).length(perspectives.length),
    strengths: z.array(text),
    improvements: z.array(text),
  }).strict();
}

export function validateAssessment(kind: JudgmentKind, value: unknown): Assessment {
  const result = assessmentSchema(kind).safeParse(value);
  if (!result.success || new Set(result.data.perspectives.map(item => item.perspective)).size !== result.data.perspectives.length) {
    // Validation errors can contain provider-returned content; keep the public error generic.
    throw new Error('The judge returned an invalid assessment. Retry this judgment.');
  }
  const order = kind === 'code' ? CODE_PERSPECTIVES : INTERVIEW_PERSPECTIVES;
  return { ...result.data, perspectives: order.map(name => result.data.perspectives.find(item => item.perspective === name)!) };
}
