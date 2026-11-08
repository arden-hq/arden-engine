# Contributing

Thanks for helping. Bug reports, fixes and small features are welcome. For a
larger change, open an issue first so we can agree on the shape.

## Setup

You need Bun 1.3.10, Node 24 or newer, and `just`.

```bash
bun install
just build
just check    # typecheck, lint, format, dead code, import rules, then all tests
```

## Rules

- `AGENTS.md` lists the rules for code in this repo. They apply to people and
  coding agents alike.
- TypeScript follows `.claude/skills/ts-style/SKILL.md`.
- A database change is a new numbered migration. Never edit a released one.
- Add a test only for logic that matters: security, permissions, storage and
  data loss, wire contracts, or a real bug you fixed.
- `just check` must pass before you open a pull request. CI runs it too, plus
  a secrets scan.

## Pull requests

Keep one change per pull request, and say in the description what changes and
why. By sending a pull request you agree that your work is licensed under the
Apache License 2.0, like the rest of this repo.

## Security

Report security problems privately. See `SECURITY.md`.
