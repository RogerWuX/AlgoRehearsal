import { parseProblemBank } from '../storage/problemStorage';

export function loadProjectQuestions() {
  const result = parseProblemBank(process.env.EXPO_PUBLIC_PROJECT_QUESTIONS ?? '[]');
  return {
    problems: result.problems,
    warning: process.env.EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING
      || (result.invalid ? 'Some questions in question/questions.json could not be imported. Check the JSON format and required fields, then restart Expo.' : ''),
  };
}
