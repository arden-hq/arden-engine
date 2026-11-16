# Agent guide

- TypeScript: read `.claude/skills/ts-style/SKILL.md` before writing any.
- Effect: read `node_modules/effect/AGENTS.md` completely before writing Effect
  code; for APIs it does not cover, search `node_modules/effect/src`.
- Tools and steering: read `libs/loop/README.md` (Background tools and
  steering) before changing tool execution or provider capabilities.
- Database: every schema or data-shape change is a numbered migration; follow
  `docs/recipes/add-migration.md`. Never edit a released migration; fix forward.
  Heavy row rewrites are backfills (`persistence/sqlite/backfills/`), not
  blocking migrations.
- Tool inputs: the model names a page, task, offer, chat or mail by link or
  slug, never by a hash, and never passes a version code back. The server
  keeps "did this change since the run read it" itself, in the run's
  `observations`. `tool-contract.ts` refuses a hash input at start.
- Before a commit: `just check` (typecheck, lint, format, tests).

## Recipes

A recipe shows one real past change file by file and ends with a check to run.
Read the recipe before you start the task; `just check` fails when a recipe
names a file that is gone.

| Task | Recipe |
|---|---|
| Add, change or remove a table, column, index or trigger | `docs/recipes/add-migration.md` |
| Add a tool the model can call, or change one | `docs/recipes/add-tool.md` |
| Add a model provider or model server | `docs/recipes/add-provider.md` |
| Add an outside event that can start an Automation | `docs/recipes/add-outside-event.md` |

## Development ledger

Every feature gets a development ledger (the `development-ledger` skill), started
before the first edit. A feature is new or changed behaviour a person or the model
can see; one bug fix or a docs change does not need one. The ledger holds the
request in the owner's words, the points that mean "done", decisions with their
reasons, and what was checked.

Keep it in `.local/ledgers` of the main checkout, which git ignores. A worktree's
own `.local` is deleted with the worktree, so from a worktree use:

```bash
ledger.py new "Title" --root "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.local/ledgers" --intent-file -
```

Resume one with `ledger.py list` from the main checkout.

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
