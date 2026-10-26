import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { generateRandomNumber } from '../../utils';
import { problemSchema, validateProblem, type Problem } from '../../model/problem';
import type { SearchResult } from '../../llm/types';

export function createSelectionTools(search: (query: string) => Promise<SearchResult>, submit: (problem: Problem) => void): StructuredToolInterface[] {
  return [
    tool(async ({ query }: { query: string }) => JSON.stringify(await search(query)), {
      name: 'search_problem', description: 'Search the web to find and verify a real interview problem. Returns search text and source URLs.',
      schema: z.object({ query: z.string().trim().min(1) }),
    }),
    ...createSubmissionTools(submit),
  ];
}

// The managed agent searches on Google's servers and shares these local tools.
export function createSubmissionTools(submit: (problem: Problem) => void): StructuredToolInterface[] {
  return [
    tool((args: { min: number; max: number }) => JSON.stringify({ number: generateRandomNumber(args) }), {
      name: 'gen_random_number', description: 'Generate a uniformly random integer between min and max, inclusive. Choose bounds according to the selection instructions.',
      schema: z.object({ min: z.number().int().safe(), max: z.number().int().safe() }),
    }),
    tool((args: unknown) => {
      submit(validateProblem(args));
      return JSON.stringify({ accepted: true });
    }, {
      name: 'submit_problem', description: 'Submit a verified problem for a separate interviewer. Include the complete description, examples, constraints, and source URL; omit solutions.',
      schema: problemSchema,
    }),
  ];
}
