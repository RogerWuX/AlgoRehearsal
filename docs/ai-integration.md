# AI integration

[Project overview](../README.md) · [Architecture](architecture.md) · [Development](development.md) · [Persistence and logging](persistence-and-logging.md)

## Configuration and runtime

The [supported-model registry](../src/shared/apiConfig.ts) is the source of truth for dropdown labels, exact IDs, provider/factory routing, capabilities, and Live thinking effort. The current application configuration is:

| Capability | Model ID | Adapter | Default / effort |
| --- | --- | --- | --- |
| Live | `gemini-3.8-live-extended-thinking` | Google Gen AI Live | Yes; Medium effort. |
| Live | `gemini-3.8-live` | Google Gen AI Live | Alternative; no configurable effort. |
| Thinking | `gemini-3.8-flash` | LangChain `ChatGoogle` | Yes. |
| Thinking | `antigravity-preview-09-2026` | `ChatAntigravity` over Google Interactions | Alternative preview. |

Lookup trims IDs and checks exact registration, capability, and Thinking provider before SDK construction. A model-name prefix does not establish support. Extended Live effort maps Low/Medium/High to SDK thinking levels; standard Live receives no thinking configuration.

The web composition shares one [Thinking runtime](../src/features/interview/llm/runtime.ts) between selection and grading. It caches a model per provider/model and replaces it when the credential changes. Factories supply the LangChain model, search support, capabilities, and optional per-run lifecycle; the runtime adds identity and credential-redacting loggers.

Live uses its own credential and transport rather than the Thinking runtime. These integrations make provider requests from the web app.

## Problem selection and search

The selector separates stored-bank acquisition from agent selection. Stored mode uses cryptographic randomness over the validated bank, bypassing selection prompts and model calls. Agent mode receives the bundled instructions plus an optional problem-search description from settings.

Both providers use the shared [selection agent](../src/features/interview/agents/selection/selectionAgent.ts) and local tools:

| Tool | Contract |
| --- | --- |
| `gen_random_number` | Inclusive safe-integer `min`/`max`; returns `number`. |
| `submit_problem` | Validated title, HTTP(S) source URL, description, examples, and constraints. |
| `search_problem` | Google path only: query to grounded search text and source URLs. |

Google search is a separate `ChatGoogle` call with the built-in Google Search tool. Antigravity supplies managed `google_search` and `url_context` tools alongside the same local random/submission handlers.

Full LangChain messages preserve provider metadata across tool turns. Tool validation errors permit correction; duplicate call IDs reuse results. The first valid problem submission ends selection without another inference request. Free-form final text is insufficient. Search responses and returned URLs are treated as data; managed search observation is limited to returned provider steps.

The [question guide](../question/README.md) defines the shared problem shape. Question-bank saving policy and recovery remain separate from agent invocation.

## Live transport and browser audio

The [interviewer factory](../src/features/interview/agents/interviewer/createInterviewer.ts) prepares system instructions and role/text initial turns for an injected transport:

- A fresh interview sends one opening turn containing the problem.
- Checkpoint resumption sends no opening turns.
- Recovery without a checkpoint sends the saved problem, conversation, and continuation instruction.

The [Gemini transport](../src/features/interview/adapters/live/gemini/transport.web.ts) uses `@google/genai/web` and API version `v1beta`. It sends prepared initial content once after setup and before readiness. Text and audio use realtime input; microphone stop sends an audio-stream-end notification. Incoming audio/transcriptions continue to be handled across completed turns.

Discussion sends use a `[Discussion notes]` marker and retain the sent text in the transcript while chat presents a compact notice. The session reconciles matching transcription echoes with those notices.

Browser audio owns capture, encoding, playback, and interruption. PCM is signed 16-bit little-endian; capture requests a 16 kHz context and sends its actual sample rate. Playback reads the response rate with a 24 kHz fallback. Cleanup stops tracks, capture, playback, and contexts; pending permission results cannot attach to a superseded session.

## Grading and immutable submissions

[createJudgmentWorkflow](../src/features/interview/judgment/createJudgmentWorkflow.ts) owns Thinking model acquisition, phase deadlines, cancellation, and assessment validation. It runs two sequential, independent assessments:

| Assessment | Input |
| --- | --- |
| Code | Problem, captured code, and selected language. |
| Interview | Problem, captured transcript, and discussion notes. |

The submission is frozen when ending the interview. Later edits do not affect retries, which run only missing assessments. A failure in code grading does not prevent interview grading; successful feedback survives failure or cancellation of the other phase.

The shared judgment agent validates written summaries, perspective feedback, strengths, and improvements with Zod. It uses provider structured output when the model advertises support, otherwise the named `submit_assessment` tool. Grading has no search tools, code execution, numeric scores, pass/fail verdicts, or third synthesis request.

## Retry, cancellation, and managed interactions

| Phase | Application deadline |
| --- | --- |
| Agent problem selection | Five minutes. |
| Interviewer connection | Twenty seconds. |
| Each grading assessment | Five minutes. |

Google model calls and grounded search use the shared retry middleware: two retries per call, exponential delay starting at one second, and jitter. Computed backoff is capped at 60 seconds; provider retry hints can require a longer wait. Transient failures can retry; authentication, validation, permanent failures, and cancellation do not. Lower-level Thinking model/SDK retries are disabled to avoid stacking policies. Deadlines include backoff, and abort guards prevent subsequent requests.

Antigravity translates Interactions API state into LangChain messages. Each selection/judgment scope has its own model clone and continuation state while sharing the cached SDK client. Background interactions run in a remote environment; local function results continue with the previous interaction ID and returned environment. Polling waits five seconds between checks. Application creation/continuation requests have no automatic retry.

Scope disposal and cancellation best-effort cancel managed interactions, including paused interactions after successful submission. Live uses its dedicated connection lifecycle rather than the Thinking retry middleware. Late results cannot replace the active problem or revive closed resources.

## Prompts and extension points

Markdown instructions live under `src/features/interview/agents/`: [selection](../src/features/interview/agents/selection/selection.md), [grounded search](../src/features/interview/agents/selection/search-system.md), [interviewer](../src/features/interview/agents/interviewer/interviewer.md), and [judgment](../src/features/interview/agents/judgment/judgment.md).

Typed builders use `{{variable}}` substitutions and non-nested `{{#section}}…{{/section}}` blocks. Unknown tokens, malformed delimiters, and nested sections fail; inserted values stay literal. Prompts are bundled as strings and versioned/tested with application code. Short protocol messages and tool definitions stay in code.

To add Thinking support, register model metadata, extend factory routing as needed, and return the LLM with its capabilities/search/lifecycle support. Keep prompts, tool handlers, and task policy in agents. Live support requires a transport factory plus mapping of any advertised effort values. [Boundary tests](../tests/boundaries.test.cjs) enforce adapter separation.
