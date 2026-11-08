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
