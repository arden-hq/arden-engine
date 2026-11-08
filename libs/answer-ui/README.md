# `@arden-hq/answer-ui`

The definition of the `arden:ui` answer block. A model can write this block in an answer to show cards, tables, charts, diagrams and controls. The desktop renderer and the server check both read the same definition here. The server (`@arden-hq/server`) and the desktop app import it.

The library holds data and checks. It draws nothing.

## Exports

| Import | What it gives you |
| --- | --- |
| `@arden-hq/answer-ui` | `ANSWER_PARTS` (every part with its description and props schema), `COMPONENT_NAMES`, `catalogSignatures()` (the one-line list of parts shown to the model), `readAnswerBlock`, `guardBlock`, `completeStatements`, `answerBlockText`, chart and plot specs, number formats |
| `@arden-hq/answer-ui/fence` | `ANSWER_UI_FENCE` (`"arden:ui"`), the size limits and `answerBlockFits` |
| `@arden-hq/answer-ui/check` | `checkAnswerBlock(source, options)`, which lists the problems in a block, worded for the model |
| `@arden-hq/answer-ui/state` | `savedBlockState`, which keeps only the control values a block declares |
| `@arden-hq/answer-ui/tool-result` | `readToolResult`, which reads a value from an earlier tool result in the chat |

## Rules

- A block body is at most 16 KiB. Inline `App` html has its own limit of 150 KiB. A larger block shows as code.
- Saved control values are at most 8 KiB. A value that does not match its control is dropped. A forged value never reaches the store or the model.
- A block reads data only from tool results of the same chat. It writes nothing.
- To add or change a part, edit `src/parts.ts`. The renderer and the check follow.
- `answerBlockText` gives a block as plain Markdown, for places that cannot draw it.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
