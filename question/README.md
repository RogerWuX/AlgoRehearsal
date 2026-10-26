# Question database

[Project overview](../README.md) · [Development](../docs/development.md) · [Persistence and logging](../docs/persistence-and-logging.md)

Put a JSON array in [questions.json](questions.json). Metro embeds this optional file when Expo starts or exports the web app; the web app validates and merges its entries into the browser question bank on startup. Restart Expo and reload after editing it; deployed changes require a new export and deployment. The folder and file are optional.

## Format

```json
[
  {
    "title": "Pair sum",
    "sourceUrl": "https://example.com/problems/pair-sum",
    "description": "Return two distinct indices whose values sum to the target.",
    "examples": [
      {
        "input": "nums = [2, 7], target = 9",
        "output": "[0, 1]",
        "explanation": "2 + 7 = 9"
      }
    ],
    "constraints": ["2 <= nums.length <= 1000"]
  }
]
```

The shared [problem schema](../src/features/interview/model/problem.ts) requires nonempty text, an HTTP(S) source URL, at least one example with input/output, and at least one constraint. Example explanations are optional but must be nonempty when supplied. Invalid imported entries are skipped with a warning in Settings; malformed or unreadable files do not prevent use of existing saved questions.

## Import and selection

Questions with the same `sourceUrl` share one bank entry. Imports update matching entries without deleting other saved questions. Removing a question from the file does not remove its browser copy.

In **Settings → Interview → Question source**, choose **Local questions** for a random bank entry or **Web search** for agent selection. Local mode is disabled when the bank is empty. Both modes require Live and Thinking API configuration: local selection skips the Thinking agent, but final feedback still needs it. Random choices can repeat; interviewer retry reuses the selected question.

Local questions is the startup default when the imported/saved bank is nonempty and there is no valid saved source preference; otherwise Web search is the default. An explicit saved choice takes precedence. Saving settings remembers that choice; adding questions later does not automatically switch modes.

For Web search, **Save found questions** defaults off. Enabling it adds or updates accepted questions in the bank. Stored-mode selections also write question records. With search saving off, the selected question remains available for the current interview and retries; optional interview recovery can still persist it without adding it to the bank.

Browser question records use localStorage. Storage failures retain the bank in memory. See [Persistence and logging](../docs/persistence-and-logging.md#storage-ownership) for keys and the distinction between question-bank storage and active interview recovery.
