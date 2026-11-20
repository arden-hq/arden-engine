# Behavior rules

Rules that a change to the server must keep.

## Child agents

A detached child agent saves its result in a delivery outbox. The server adds it to the pending input of the parent. The loop reads it at the next model step. An idle parent starts a continuation. `agent_message` works only inside one agent family.

## Tasks in a chat

A Task with `runs_in: "chat"` takes its next step in its chat as a hidden turn. It spends the Task's token budget. A spent budget stops the Task until the person raises it. Only the person's own turn starts a Task (`task_start`). Other sources use `task_propose`. At most three proposals wait on a Space.

## Queued messages

`PUT /sessions/:sessionId/queue` takes `{ "client_ids": [...] }`, the full wanted order. If the queue changed, the server rejects the request and the client must reload.

## Wiki events

A Wiki commit is the source of `wiki.changed` events. A queue failure leaves the save done and the event pending. A retry runs every minute.

## Job classes

`scheduled_tasks.purpose` is `user_automation`, `space_review`, `task_execution` or `system`. The server never parses a job ID to classify it.

## Retiring a built-in Automation

A job with an unknown handler fails at claim. Removing an ID from `SYSTEM_HANDLER_IDS` must ship a numbered migration in the same change. The migration moves its rows off the ID.

## Detached trace

A finished detached-agent Session keeps its full trace for 24 hours. Then the server keeps only its identity, lineage, state and final result.
## Storage

- `arden.db` holds all product state.
- Wiki Markdown lives under `memory/wiki`. `@arden-hq/revisions` keeps its history. Wiki embeddings live in SQLite and rebuild from the current revision.
- Local Skills live under `skills`.
- A database change is a numbered migration in `src/persistence/migrations/`. See `AGENTS.md`. Heavy row rewrites are backfills, not migrations.
- `scripts/storage-maintenance.mjs` checks storage and rebuilds the search index. Stop the server first. Pass `--data-root <path> --confirm-stopped`.

## Security

- The listener is on loopback only. Each launch has its own access capability.
- Tokens and the listener address never reach the renderer. The desktop main process owns the ChatGPT sign-in and passes credentials to the server process.
- Access to files, commands and the browser goes through permission rules and approvals. Never use how a screen looks to grant access.
