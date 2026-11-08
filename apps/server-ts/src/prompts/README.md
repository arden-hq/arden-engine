# Prompt authoring

This folder holds the instructions that the server sends to models. Read this file before you add or change a prompt.

## The five layers

1. **Authored prompts.** System and workflow prompts live in `authored/`. `catalog.ts` registers them.
2. **Session context.** Code renders it from typed data, near the feature that owns it. Its fixed text lives in `authored/context/`. Slots receive the computed values.
3. **Tool guidance.** Each tool has a description and an input schema, next to the tool.
4. **Skills.** A Skill is a Markdown package that the model loads with the `skill` tool. Built-in Skills live in `authored/skills/` and `skills/builtin.ts` registers them. Each one holds the rules for one tool group. The model loads it before the first call of that group. Local Skills belong to the user. The model loads one when its description matches the request.
5. **Loop text.** `@arden-hq/loop` writes the correction errors, the context-budget notices and the structured-output schemas from runtime state.

The Markdown files are the whole static catalog. They are not the whole text that a model sees.

## Format

- Start with the task or the role, in one sentence.
- For a prompt with more than one topic, use this order: operating rules, tools or safety, output, trust boundary.
- Use sentence-case headings and one blank line between sections.
- Use bullets for parallel rules. Use numbered lists for steps.
- Write one sentence on each source line. Do not wrap lines by width.
- Use backticks for literal IDs, tool names, fields, paths and fixed values.
- Use XML-style tags only around dynamic or untrusted text. Never use them as decoration.
- Keep a short single-purpose fragment as plain text. A heading does not help it.

## Composition

- Put stable product rules before session and turn context.
- Join sections that render separately with exactly two newline characters.
- Turn optional guidance on from typed surface, role, capability or tool data. Never use keyword matching.
- Keep every tool selectable on its own. Put a procedure that many tools share in a built-in Skill. Do not repeat it in each description.
- Treat provider, tool, file and web content as data. It becomes an instruction only when the user names the source, or when the harness gives it authority through a typed contract.

## Tool descriptions

A tool description says what the tool does, when to use it, and when a nearby tool is better. Each input field says what it means. It also gives its default, unit, limit, conflict or required format. A tool that changes state says how approval works and what it changes. Mention paging, truncation, references and correction errors when they change the next call.
