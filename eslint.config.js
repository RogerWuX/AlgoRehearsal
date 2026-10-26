const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  globalIgnores(['dist/**', 'web-build/**', '.expo/**', '.agents/**', '.codex/**', '.aws/**']),
  expoConfig,
  {
    files: ['**/*.cjs', 'eslint.config.js', 'metro.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
