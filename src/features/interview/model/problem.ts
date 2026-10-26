import { z } from 'zod';

const text = () => z.string().trim().min(1);
function isHttpUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
export const problemSchema = z.object({
  title: text(),
  sourceUrl: text().refine(isHttpUrl, 'sourceUrl must be an HTTP(S) URL.'),
  description: text(),
  examples: z.array(z.object({ input: text(), output: text(), explanation: text().optional() })).min(1),
  constraints: z.array(text()).min(1),
});
export type Problem = z.infer<typeof problemSchema>;

export function validateProblem(value: unknown): Problem {
  const result = problemSchema.safeParse(value);
  if (result.success) return result.data;
  // Preserve the original validation order and public messages for stored imports.
  const order = ['sourceUrl', 'examples', 'constraints', 'title', 'description'];
  const issue = [...result.error.issues].sort((a, b) => {
    const priority = (path: PropertyKey[]) => path.length === 1 ? order.indexOf(String(path[0])) : 5;
    return priority(a.path) - priority(b.path);
  })[0];
  const [field, , detail] = issue.path.map(String);
  let message: string;
  if (!issue.path.length) message = 'Submit a structured problem.';
  else if (field === 'examples' && issue.path.length === 1) message = 'Provide at least one example.';
  else if (field === 'constraints' && issue.path.length === 1) message = 'Provide at least one constraint.';
  else if (field === 'examples' && issue.path.length === 2) message = 'Each example must have input and output.';
  else if (field === 'sourceUrl' && issue.code === 'custom') message = issue.message;
  else message = `${field === 'examples' ? `example ${detail}` : field === 'constraints' ? 'constraint' : field} must be nonempty text.`;
  throw new Error(message);
}

export function formatProblem(problem: Problem): string {
  return [problem.title, `Source: ${problem.sourceUrl}`, '', 'Description', problem.description, '', 'Examples',
    ...problem.examples.map((example, index) => [`Example ${index + 1}`, `Input: ${example.input}`, `Output: ${example.output}`,
      ...(example.explanation ? [`Explanation: ${example.explanation}`] : [])].join('\n')),
    '', 'Constraints', ...problem.constraints.map(constraint => `- ${constraint}`)].join('\n');
}
