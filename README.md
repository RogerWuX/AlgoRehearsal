# AlgoRehearsal

AlgoRehearsal is a data structures and algorithms (DSA) interview simulator built with Expo and React Native. Practice with a browser code editor, a Gemini Live interviewer, and separate AI assessments of your solution and interview.

Try the [deployed web app](https://rogerwux.github.io/AlgoRehearsal/).

## Technical overview

- TypeScript features own editor, interview, and settings state behind explicit module boundaries.
- A plain TypeScript session controller coordinates injected selection, grading, transport, audio, and persistence dependencies.
- CodeMirror 6 handles browser editing; shared LangChain agents use Google and Antigravity model adapters.
- Browser storage supports optional recovery and structured diagnostic logs.

Live interviews, AI grading, and persistent recovery run in the web app. Android and iOS have native editing and settings fallbacks with session-only state. Assessments analyze submissions without executing code.

## Run locally

Use Node.js 22.13 or newer and npm.

```sh
cd AlgoRehearsal
npm install
npm run web
```

Open the URL printed by Expo. Enter the independent Live and Thinking credentials in **Settings → Model** before starting an interview. Enable **Remember API keys** to retain them across reloads in the current browser tab.

## Technical documentation

- [Architecture](docs/architecture.md): feature boundaries, session composition, and data flow.
- [Development](docs/development.md): setup, credentials, Metro, builds, and verification.
- [AI integration](docs/ai-integration.md): model routing, agents, prompts, and provider lifecycles.
- [Persistence and logging](docs/persistence-and-logging.md): browser storage, recovery, credentials, and diagnostics.
- [Question database](question/README.md): bundled question format and import behavior.
