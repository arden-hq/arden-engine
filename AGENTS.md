# Agent guide

- TypeScript: read `.claude/skills/ts-style/SKILL.md` before writing any.
- Effect: read `node_modules/effect/AGENTS.md` completely before writing Effect
  code; for APIs it does not cover, search `node_modules/effect/src`.
- Tools and steering: read `libs/loop/README.md` (Background tools and
  steering) before changing tool execution or provider capabilities.
- Database: every schema or data-shape change is a numbered migration in
  `apps/server-ts/src/persistence/migrations/000N_<name>.ts`, appended to
  `migrations` in `index.ts`, with the matching edit to
  `persistence/schema/sections`. Never edit a released migration; fix forward.
  Heavy row rewrites are backfills (`persistence/sqlite/backfills/`), not
  blocking migrations.
- Before a commit: `just check` (typecheck, lint, format, tests).

## Pull request descriptions

A full agent-written PR description is accurate but too long to read. Write
every PR description in this shape
([Simon Willison, 2026-11-09](https://simonwillison.net/2026/Nov/9/details-summary/)):

1. One or two sentences first: what the change does and whether it needs a
   close look. Check each claim against the diff; this is the part a person
   vouches for.
2. A screenshot when the change is visible.
3. The full description in a collapsed block, labeled with the model and effort.
   Keep the blank lines, or GitHub does not render the Markdown inside:

```html
<details>
<summary>Claude Opus 5.5, medium effort (the model and effort used)</summary>

…the full description…

</details>
```
