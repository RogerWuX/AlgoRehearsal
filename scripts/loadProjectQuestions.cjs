const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function loadProjectQuestions(projectRoot, env = process.env, readFile = readFileSync) {
  // Expo embeds this public data in the web bundle, including production exports.
  env.EXPO_PUBLIC_PROJECT_QUESTIONS = '[]';
  env.EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING = '';
  try {
    env.EXPO_PUBLIC_PROJECT_QUESTIONS = readFile(join(projectRoot, 'question', 'questions.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      env.EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING = 'Could not read question/questions.json. Check the file permissions and restart Expo.';
    }
  }
}

module.exports = { loadProjectQuestions };
