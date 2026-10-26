# Repository Guidelines

## Project Structure & Module Organization

This Expo/React Native interview simulator uses TypeScript. `index.ts` registers `src/App.tsx`. Features live in `src/features/editor`, `interview`, and `settings`; shared configuration, logging, and storage utilities live in `src/shared`, with declarations in `src/types`.

Keep components, hooks, models, and storage within their feature. Browser implementations use `.web.ts` or `.web.tsx` alongside native counterparts. Interview prompts are Markdown assets under `src/features/interview/agents/`. `question/questions.json` supplies the bundled question bank; `scripts/` contains Metro loaders and transformers. Tests and fixtures live in `tests/` and `tests/helpers/`. Generated web exports go to `dist/`.

## Build, Test, and Development Commands

Use Node.js 22.13 or newer and npm.

- `npm install`: install dependencies.
- `npm run web`: start local web development; `npm start` opens Expo's platform chooser.
- `npm run android` / `npm run ios`: launch the corresponding platform.
- `npm run lint`: run Expo's flat ESLint configuration; `npm run lint:fix` applies automatic fixes.
- `npm run typecheck`: check application TypeScript with strict and unused-local checks.
- `npm test`: run credential-free mocked suites.
- `npm run test:metro`: verify Android/iOS development and production bundles.
- `npm run build:web`: export the web app to `dist/`.

After Metro configuration changes, restart with `npx expo start --web --clear`.

## Coding Style & Naming Conventions

Follow existing two-space indentation, single quotes, and semicolons. Use PascalCase for components and types, camelCase for functions and variables, and `use` prefixes for hooks. Keep TypeScript strict. Import feature APIs through their `index.ts` exports where appropriate. Provider adapters must not import agent prompts or selection, judgment, or session policy; boundary tests enforce this separation.

## Testing Guidelines

Project hooks snapshot Git-visible project files before each user turn. At agent stop, including Plan mode, they run `npm run lint`, `npm run typecheck`, and `npm test` only when Git has changes and files differ from the starting snapshot. Clean Git and unchanged pre-existing edits skip all three checks. Missing or invalid snapshots trigger checks conservatively on dirty Git; a failed stop check requests one automatic retry. Agents do not need to run these three commands explicitly.

Tests use `node:test` and `node:assert/strict`, with mocked browser and SDK boundaries. Name suites `tests/<area>.test.cjs` and register new suites in `tests/run.cjs`. Run a focused suite with `node tests/editor.test.cjs`. Cover changed behavior and failure paths; no numeric coverage threshold is configured. For UI changes, manually verify affected web interactions and native fallbacks.


## Security & Configuration

Never commit credentials. Enter Live and Thinking credentials independently in Settings → Model. Remember API keys optionally retains them in the current browser tab's sessionStorage. Keep credentials separate and excluded from logs and interview snapshots.
