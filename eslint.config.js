const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  globalIgnores(['dist/**', 'web-build/**', '.expo/**', '.agents/**', '.codex/**', '.aws/**']),
  expoConfig,
  {
    files: ['**/*.cjs', 'app.config.js', 'eslint.config.js', 'metro.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
