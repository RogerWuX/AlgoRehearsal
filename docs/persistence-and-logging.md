# Persistence and logging

[Project overview](../README.md) · [Architecture](architecture.md) · [Development](development.md) · [AI integration](ai-integration.md)

## Storage ownership

The web app stores data per browser origin. Native editing and settings keep state in memory; Live interviewing and recovery are web-only.

| Data | Backend / key | Retention policy |
| --- | --- | --- |
| Credential-free settings | localStorage: `interview-practice.settings` | Saved configuration preferences. |
| Editor document | localStorage: `interview-practice.editor.document` | Only with Save interview progress enabled. |
| Interview snapshot | localStorage: `interview-practice.interview` | Only with Save interview progress enabled. |
| Question bank | localStorage: `interview-practice.questions` | Imported questions and saved selections. |
| Persisted selected question record | localStorage: `interview-practice.problem` | Written with stored selections or saved search selections; also joins the bank on startup. |
| Live/Thinking credentials | sessionStorage: `interview-practice.api-keys` | Only with Remember API keys enabled, for the current tab session. |
| Structured logs | IndexedDB: `interview-practice-logs` | Seven days, capped at 50 MiB. |

[Preference serialization](../src/features/settings/storage/preferencesStorage.ts) explicitly copies allowed fields and excludes credentials. It validates saved models and defaults unsupported values. Editor language belongs to the editor document; the selected workspace tab is not persisted.

Question-bank storage is independent of interview recovery. The session restores an active problem only from a valid interview snapshot, so question records alone do not reopen an interview. See the [question guide](../question/README.md) for import/merge behavior.

## Editor and interview recovery

**Settings → Interview → Save interview progress** defaults off. Disabled recovery clears saved interview/editor records; current in-memory state remains usable until reload. Reopening starts with empty code in C++ and no selected interview, discussion, or feedback, while the question bank remains available.

The editor stores `{ version: 1, text, language }`. Missing or unsupported language metadata uses C++ while preserving valid text; malformed documents or unsupported versions restore an empty document. The obsolete text-only key is ignored and left untouched.

The [interview repository](../src/features/interview/storage/interviewStateStorage.ts) stores a versioned snapshot of lifecycle, problem, transcript, discussion, credential-free Live configuration, resumption handle, and grading state/submission. Read/write validation whitelists fields and requires discussion strings in both session state and any grading submission. Invalid snapshots produce a warning and remain stored until a subsequent save or clear.

Recovery interprets saved lifecycle rather than reconnecting every record:

- Active interviews reconnect automatically when credentials are available.
- Paused interviews wait for an explicit resume; ended interviews restore feedback without connecting.
- Interrupted selection requires a new start. Interrupted grading preserves completed assessments and allows retry of unfinished work.

When a usable Gemini checkpoint exists, the adapter attempts session resumption. Otherwise, or when that connection cannot resume, a new Live connection continues with the saved problem and conversation. Automatic recovery leaves the microphone off and may need **Enable audio** for playback; audio received before activation is discarded while transcription is retained.

## Credentials and unavailable storage

**Settings → Model → Remember API keys** defaults off and is independent of interview recovery. With it enabled, both keys are saved in the current tab's sessionStorage for reloads. Turning it off clears the saved keys. Recovery requests credential re-entry when remembered values are unavailable.

Credentials are entered in Settings and excluded from localStorage preferences and interview snapshots. They remain in memory unless key retention is enabled.

Storage failures preserve in-memory state and expose unavailable/session-only status. Editing, settings, and question selection remain usable when browser storage is blocked or full. Failed editor saves can retry on later document changes; recovery cannot survive reload when its writes fail.

## Structured logging

The [shared logger](../src/shared/logger.ts) exposes `debug`, `info`, `warn`, `error`, and child context. Records contain timestamp, level, scope, event, context, and optional data. Values are snapshotted before asynchronous persistence; sensitive field names and configured secrets are redacted.

Web logs persist every level through `react-native-logs`; only errors reach `console.error` with the `[interview-practice]` prefix. Native builds print errors, discard lower levels, and keep no persistent logs. This behavior is the same in development and production; Expo/Metro terminal output is separate.

Selection diagnostics include full provider-returned messages/metadata, search responses, tool results, and accepted problem content. Grading records progress, timing, and input sizes without code, transcript, reports, or raw provider errors. Normal Live transcript content, audio chunks, and editor keystrokes/code are omitted.

Follow `sessionId` and `attemptId` across workflow records. A typical agent selection emits `selection.started`, `llm.response` or `interaction.response`, tool events, `problem.accepted`, and `problem.loaded`. Stored selection logs its index, bank size, and in-memory origin. A source URL alone does not prove a search occurred; managed search visibility is limited to provider-returned steps.

## Retention and export

[Log storage](../src/shared/logStorage.ts) serializes UTF-8 JSON Lines, including line terminators in byte accounting. IndexedDB separates payload records from retention metadata so pruning does not scan full provider payloads.

Records older than seven days are removed, then oldest records are evicted to maintain the 50 MiB cap. When IndexedDB fails, new records use a bounded 5 MiB memory buffer with the same age limit. Oversized/unserializable records are omitted and reported; session records are lost on reload.

**Settings → Diagnostics → Application logs** offers Download logs and Clear logs even when interview configuration is locked. Exports use `interview-practice-logs-<UTC timestamp>.jsonl` and include retained browser records when readable plus buffered session records within the retention cap.

Export and clear wait for earlier queued writes. Clear removes persisted and buffered records; if the persisted clear fails, the buffer still clears and Settings reports the failure. Subsequent events can create new records. Diagnostics displays storage status, omissions, and operation errors.
