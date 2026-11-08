# `@arden-hq/prompt-template`

A strict renderer for prompt templates. A template is text with `{{name}}` slots. `@arden-hq/server` uses it for its prompt catalog.

```ts
import { compilePromptTemplate, renderPromptTemplate } from "@arden-hq/prompt-template"

const template = compilePromptTemplate({ source: "Hello {{name}}." })
renderPromptTemplate({ template, values: { name: "Ada" } }) // "Hello Ada."
```

## Exports

- `compilePromptTemplate({ source })` parses a template once. The result lists its `slots` in first-use order.
- `renderPromptTemplate({ template, values })` fills the slots from an object.
- `renderPromptTemplateEntries({ template, values })` does the same from `[name, value]` pairs.
- `PromptTemplateError` carries a `reason` and, when known, a `location` (byte offset, line, column).

## Rules

- Rendering is strict. A missing, extra, duplicate or `undefined` value is an error. A malformed, empty or nested slot is an error.
- `{{{{` and `}}}}` give the literal characters `{{` and `}}`.
- Source line endings become LF before parsing.
- The library has no loops, no conditions and no file access.

## Build

```bash
bun run build
bun run typecheck
```
