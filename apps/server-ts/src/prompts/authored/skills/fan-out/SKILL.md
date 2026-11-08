---
name: fan-out
description: Spread many small, independent items across parallel child agents in a Workflow, then check and merge what comes back.
version: 1.1.0
tool_group: Parallel child Agents over many items
user_invocable: true
---

# Fan-out Skill

Whether to delegate is decided before this Skill; it covers running many workers over many items.

## When it helps

- Fan out when the work is many items that can each be handled without the others: read every file, check every record, apply the same change across a codebase. Reading everything directly can beat writing heuristics to avoid reading it.
- Stay in one agent when items depend on each other, when there are only a few, or when the hard part is one judgment rather than volume. Prefer grep or a deterministic script when it answers the question exactly.

## Shape the run

- Use `research` workers when the result is information; use `code` workers only when they must change files.
- Omit `model` to use the Background model, which is meant for this. Choose a stronger model only when results show the default is not good enough.
- Fit the work to `budget.remaining()`: when items outnumber the agents you can launch, give each worker a group of related items.
- Give every worker the same short brief: the goal, what a good result looks like, one worked example when the task is subtle, and what to do with an item it cannot handle.
- Pass a `schema` so results come back compact and comparable. Include the evidence for each claim (a path, a line, a short quote) and a status per item, so exceptions surface instead of hiding in prose.

## Pilot

- For large or unfamiliar batches, pilot a few typical and difficult items first. Read those results yourself, adjust the brief or the model, then run the rest.

## Check the outcome

- The runtime already retries schema failures and restarts failed workers; do not wrap `agent()` in your own retry loop. Handle the items that still fail as exceptions.
- A valid schema is not a correct result. Where a mechanical check exists (typecheck, tests, a query), run it over the whole result. Then read a sample of results against their evidence.
- Merge the compact results; do not paste raw worker output into your own context. Report what changed or what was found, the exceptions with their reasons, and what you checked.
