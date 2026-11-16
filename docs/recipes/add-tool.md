# Add or change a built-in tool

Use this when the model needs a new tool, or a tool needs a new parameter. It is
one real change shown file by file: `artifact_delete` (old repo commit
`ba3f62635`), on `main` today in the files below. Copy its shape.

## 1. Write the tool

`apps/server-ts/src/tools/artifact-delete.ts`, cut to the parts every tool has:

```ts
const ParametersSchema = Schema.Struct({
  refs: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)))
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ITEMS))
    .annotate({ description: "What to delete: the artifact_ref or path artifact_save, …" })
})
…
  return defineServerTool({
    name: "artifact_delete",
    description: ["Delete files Arden saved in this chat: …", …].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "arden_db",
      scopes: ["agent_research"],
      display_name: "Delete artifact",
      kind: "filesystem",
      action: "write",
      approval_preview: "Delete files Arden saved in this chat.",
      source: "_filesystem",
      changes_state: true,
      target: "reported",
      concurrency_group: "conversation_artifacts",
      destructive: true,
      default_approval: "approve",
      approval_bypass: true
    },
    execute: async (input, ctx, effects) => { … return { result, preview, data } }
  })
…
export const artifactDeleteTools = Effect.gen(function* () { … })
```

- On a field that changes its input (`Schema.Trim`, a decoding default), write
  `.pipe(Schema.annotateEncoded({ description }))`. `.annotate` is lost there.
- No input: use `EmptyParametersSchema` from
  `apps/server-ts/src/tools/automation-tool-schema.ts`. OpenAI refuses `Schema.Struct({})`.
- Take a link, path or slug, never a hash (`AGENTS.md`, "Tool inputs").
- A write tool that Automation or Memory runs call needs `unattended_scope`, or
  it waits for an approval no one can give.
- Refuse with a `ToolExecutionError` that says what to do next, not a generic one.

## 2. Register it

In `apps/server-ts/src/tools/registry.ts`, import it and add it to `builtinTools`
(`import { artifactDeleteTools } from "./artifact-delete.js"`, then
`artifactDeleteTools,` after `artifactSaveTools,`).

## 3. Catalog, summary and words

- `apps/server-ts/src/tools/tool-catalog.ts`: add the name to a `TOOL_GROUPS`
  group (here `output`) so search finds it. Never name a group `browser`; OpenAI
  reserves it. For each parameter that takes an id or link, add an
  `INPUT_SOURCES` row: the parameter, then the tools that hand it out.
- `apps/server-ts/src/tools/tool-summaries.ts`: one line for the public catalog.
- `libs/protocol/src/views/tool-words.ts`: the verb the app shows.

```ts
  artifact_delete: inputs(["refs", "artifact_save", "browser_screenshot", "exec_command"]),
  artifact_delete: "Deletes a file Arden saved in a chat.",
  artifact_delete: { verb: "Deleted an artifact", icon: "dot", many: "Deleted artifacts" },
```

If the model must prefer the tool over another way (here, over `rm`), say so in
`apps/server-ts/src/prompts/authored/chat/base.md`.

## Change a tool's parameters

Find the tool with `grep -rn '"<tool_name>"' apps/server-ts/src/tools` and read its
schema first: the parameter may exist with another range.

Commit `9529af5` gave `wiki_page_history` an optional `line`, now in
`apps/server-ts/src/tools/wiki-page-history.ts`. Its first version used
`.annotate` and the server refused to start (`fc00b66`). The fixed field:

```ts
  line: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LINE_CHARS))
    .pipe(Schema.annotateEncoded({ description: "Text from one line of the page. …" }))
    .pipe(Schema.optionalKey)
```

Add the pair to its `INPUT_SOURCES` row: `["line", "wiki_read_page"]`. A renamed
or removed parameter must leave that row and the prompts too.

## Check

```bash
cd apps/server-ts && bun run typecheck && bunx vitest run test/startup-without-credential.test.ts
```

It boots the server, which checks every tool. It takes about 12 seconds and must
show `Tests  1 passed (1)`. On a fault it shows `ServerError: Failed to
start Arden server`; the lines under `Built-in tools break their contract:` say why:

- `<tool> has no entry in TOOL_SUMMARIES`: step 3.
- `TOOL_SUMMARIES has <tool>, which is not a built-in tool`: step 2 is missing.
- `<tool>.<param> has no description`: use `annotateEncoded` (step 1).
- `INPUT_SOURCES.<tool> names input <x>, which <tool> does not take`: a wrong
  or removed parameter in that row.
- `<tool> parameters must be type "object" at the root`: use `EmptyParametersSchema`.
- `<tool> is labeled read but changes state`, or `Tool <tool> changes state but
  does not declare its target`: fix `action` or add `target: "reported"`.
- `<tool> uses concurrency group <x>`: reuse a name in `CONCURRENCY_GROUPS`.

It does not catch a tool missing from `TOOL_GROUPS` or from the words file; check both.
