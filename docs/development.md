# Development

[Project overview](../README.md) · [Architecture](architecture.md) · [AI integration](ai-integration.md) · [Persistence and logging](persistence-and-logging.md)

## Setup and credentials

Use Node.js 22.13 or newer and npm. Install dependencies with `npm install`, then run `npm run web` and open the URL printed by Expo. CodeMirror and Markdown prompts are bundled locally.

Configure **Settings → Model** with independent credentials:

| Configuration | Use | Credential |
| --- | --- | --- |
| Live API | Realtime interviewer and voice conversation. | Standard Gemini API key or server-issued Live ephemeral token. |
| Thinking API | Problem selection, search, and code/interview assessments. | Standard API key for the configured Thinking model; Live ephemeral tokens are rejected. |

Both configurations are required to start or retry an interviewer, including with local questions, because grading needs Thinking. Settings can save incomplete credentials for later entry. Saving settings does not connect.

Enter credentials in Settings. Both fields start empty unless **Remember API keys** was enabled and keys are available in the current browser tab's sessionStorage. Native settings keep credentials in memory for the current app session. Keep Live and Thinking credentials separate and uncommitted. Runtime retention is described in [Persistence and logging](persistence-and-logging.md).

## Commands and build outputs

The command source of truth is [package.json](../package.json).

| Command | Purpose |
| --- | --- |
| `npm start` | Expo platform chooser. |
| `npm run web` | Web development server. |
| `npm run android` / `npm run ios` | Native development launch. |
| `npm run lint` / `npm run lint:fix` | Expo flat ESLint checks / automatic fixes. |
| `npm run typecheck` | Strict application TypeScript checks, including unused locals. |
| `npm test` | Credential-free suites with mocked SDK/browser boundaries. |
| `npm run test:metro` | Complete Android/iOS development and production bundles plus web dependency execution. |
| `npm run build:web` | Web export into `dist/`, including assets from `public/`. |

`tsconfig.typecheck.json` checks the entrypoint and both native/web application sources. It inherits Expo resolution conditions and maps React Native internal imports to shipped declarations. Dependency shims cover `invariant` and native asset-registry types; runtime resolution remains Metro's responsibility.

## Metro and bundled assets

[metro.config.js](../metro.config.js) extends Expo's default configuration:

- Markdown is transformed into UTF-8 string modules by [markdownTransformer.cjs](../scripts/markdownTransformer.cjs). Prompts require no runtime filesystem access or fetch.
- The optional project question database is read at startup/export and embedded for web. See the [question format and import guide](../question/README.md).
- LangSmith resolves through its CommonJS build to avoid its circular-export initialization failure under Fast Refresh. Browser replacements keep filesystem and worker modules out of that build.
- LangChain's unused dynamic model loader is mapped to a local shim because Metro cannot bundle `import(variable)`. Agents receive constructed model instances; model-name loading through `initChatModel` is unavailable.

After changing Metro configuration, restart with:

```sh
npx expo start --web --clear
```

Prompt changes are picked up through development bundle refreshes. Project question-file changes require restarting Expo and reloading. Deployed changes to either require a new web export and deployment.

## Verification

Tests use `node:test` and `node:assert/strict`; suites are registered in [tests/run.cjs](../tests/run.cjs). Run a focused suite with, for example, `node tests/editor.test.cjs`. Shared agent tests execute real LangChain graphs with scripted models; SDK, storage, browser audio, and React boundaries are mocked.

The separate Metro suite bundles the full native entrypoint in development and production, exercises the web session dependency graph with Fast Refresh, and checks bundled agents and asset loaders. It verifies bundling and execution paths, not provider availability or device interaction.

Use browser/device checks for behavior mocks cannot establish:

- CodeMirror syntax highlighting, language changes, cursor/undo preservation across Workspace/Results, keyboard focus, and narrow layouts.
- With valid credentials, stored/search selection, one interviewer opening, text and discussion sends, microphone permission, transcription, playback, and disconnect cleanup.
- Recovery disabled/enabled, independent key retention, credential re-entry, audio activation after automatic recovery, and paused-interview resumption.
- Independent code/interview assessments, partial failure or cancellation, and retry against the original submission.
- Native editing/settings fallbacks on a simulator or device.

Microphone capture requires HTTPS or localhost and browser permission. Search quality, provider compatibility, and live audio need credentials and browser verification.
