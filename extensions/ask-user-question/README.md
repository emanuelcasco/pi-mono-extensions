# ask-user-question — Interactive Form Tool for pi

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that registers a tool the LLM can call to ask the user structured questions using rich form controls: **radio buttons**, **checkboxes**, and **text inputs**.

Instead of the LLM asking questions in plain text and waiting for a freeform response, this tool presents an interactive TUI form where each question is typed, validated, and returned as structured data.

## How It Works

1. **LLM calls the tool** — Passes a JSON schema of questions with types, options, and metadata.
2. **Form renders** — An interactive panel appears in the terminal with typed controls for each question.
3. **User answers** — Navigate between questions, select options, type text, toggle checkboxes.
4. **Structured return** — Answers are returned to the LLM in a clean, structured format.

## Question Types

### Radio (single-select)

```
 ❯ ◉ PostgreSQL
   ○ MySQL
   ○ SQLite
   ○ Other...
```

Pick exactly one option. Press Enter to select. The "Other..." option opens a text editor for a custom answer.

### Checkbox (multi-select)

```
 ❯ ☑ Unit tests
   ☑ Integration tests
   ☐ E2E tests
   ☐ Other...
```

Toggle multiple options with Space. The "Other..." option opens a text editor. Press Enter to advance.

### Text (free input)

```
 ┌─────────────────────────────────┐
 │ Describe the migration strategy │
 └─────────────────────────────────┘
```

A full multi-line editor. Shift+Enter for newlines, Enter to submit.

## Tool Schema

```json
{
  "title": "Project Setup",
  "description": "Let me configure the project based on your preferences",
  "questions": [
    {
      "id": "database",
      "type": "radio",
      "prompt": "Which database should we use?",
      "label": "Database",
      "options": [
        { "value": "postgres", "label": "PostgreSQL", "description": "Best for complex queries" },
        { "value": "mysql", "label": "MySQL", "description": "Widely supported" },
        { "value": "sqlite", "label": "SQLite", "description": "Lightweight, file-based" }
      ],
      "allowOther": true
    },
    {
      "id": "testing",
      "type": "checkbox",
      "prompt": "Which test types should we set up?",
      "label": "Testing",
      "options": [
        { "value": "unit", "label": "Unit tests" },
        { "value": "integration", "label": "Integration tests" },
        { "value": "e2e", "label": "E2E tests" }
      ],
      "allowOther": true
    },
    {
      "id": "notes",
      "type": "text",
      "prompt": "Any additional notes or requirements?",
      "label": "Notes",
      "required": false,
      "placeholder": "Type any extra context here..."
    }
  ]
}
```

### Question Fields

| Field         | Type                              | Default                | Description                                           |
| ------------- | --------------------------------- | ---------------------- | ----------------------------------------------------- |
| `id`          | `string`                          | _required_             | Unique identifier                                     |
| `type`        | `"radio"` \| `"checkbox"` \| `"text"` | _required_        | Control type                                          |
| `prompt`      | `string`                          | _required_             | The question text                                     |
| `label`       | `string`                          | `Q1`, `Q2`...          | Short label for tab bar                               |
| `options`     | `Option[]`                        | `[]`                   | Choices for radio/checkbox                            |
| `allowOther`  | `boolean`                         | `true` (radio/checkbox) | Show "Other..." option with text input               |
| `required`    | `boolean`                         | `true`                 | Must be answered before submit                        |
| `placeholder` | `string`                          | —                      | Placeholder text for text inputs                      |
| `default`     | `string` \| `string[]`            | —                      | Default value(s)                                      |

### Option Fields

| Field         | Type     | Description                        |
| ------------- | -------- | ---------------------------------- |
| `value`       | `string` | Value returned to the LLM          |
| `label`       | `string` | Display label                      |
| `description` | `string` | Help text shown below the label    |

## Panel Interface

### Single Question

```
──────────────────────────────────────────────────────
 Which database should we use? [single-select]
 *required

 ❯ ◉ PostgreSQL
      Best for complex queries
   ○ MySQL
      Widely supported
   ○ SQLite
      Lightweight, file-based
   ○ Other...

 ↑↓ navigate • Enter select • Esc cancel
──────────────────────────────────────────────────────
```

### Multiple Questions (tab bar)

```
──────────────────────────────────────────────────────
 Project Setup
 Let me configure the project based on your preferences

 ✓ Database │· Testing │· Notes │✓ Submit

 Which test types should we set up? [multi-select]
 *required

 ❯ ☑ Unit tests
   ☑ Integration tests
   ☐ E2E tests
   ☐ Other...

 ↑↓ navigate • Space toggle • Tab/←→ navigate • Enter next • Esc cancel
──────────────────────────────────────────────────────
```

### Submit Tab (review)

```
──────────────────────────────────────────────────────
 ✓ Database │✓ Testing │✓ Notes │✓ Submit

 Review & Submit

 Database: PostgreSQL
 Testing: unit, integration
 Notes: Focus on API layer first

 Press Enter to submit

 Tab/←→ navigate questions • Enter submit • Esc cancel
──────────────────────────────────────────────────────
```

## Keyboard Reference

### Navigation

| Key               | Action                                |
| ----------------- | ------------------------------------- |
| `Tab` / `→`       | Next question (multi-question mode)   |
| `Shift+Tab` / `←` | Previous question                    |
| `↑` / `↓`         | Navigate options within a question   |

### Selection

| Key               | Action                                |
| ----------------- | ------------------------------------- |
| `Enter`           | Select radio option / advance / submit |
| `Space`           | Toggle checkbox option                |
| `Enter` (text)    | Submit text answer                    |
| `Shift+Enter`     | Newline in text/other editor          |

### Other

| Key               | Action                                |
| ----------------- | ------------------------------------- |
| `Esc`             | Cancel (in "Other" mode: go back)     |

## Output Format

The tool returns structured text to the LLM:

```
Database: PostgreSQL
Testing: unit, integration, (wrote) GraphQL tests
Notes: Focus on API layer first
```

Custom "Other" answers are prefixed with `(wrote)` so the LLM knows they were user-typed.

## System Prompt Integration

The tool includes `promptSnippet` and `promptGuidelines` so the LLM knows when and how to use it:

- Prefers `ask_user_question` over plain-text questions
- Uses radio for single-choice, checkbox for multi-choice, text for open-ended
- Groups related questions in a single call
- Includes "Other" escape hatches by default

## Dependencies

| Package                         | Role                                              |
| ------------------------------- | ------------------------------------------------- |
| `@mariozechner/pi-coding-agent` | Extension API, theme types                        |
| `@mariozechner/pi-tui`          | TUI primitives: Editor, Key, matchesKey, etc.     |
| `@mariozechner/pi-ai`           | `StringEnum` for Google-compatible enum schemas   |
| `@sinclair/typebox`             | JSON Schema definitions for tool parameters       |
