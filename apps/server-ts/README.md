# `@arden-hq/server`

The Arden agent server. It is the program that does the work: it runs chats with a model, calls tools (shell, files, browser, web, Google, MCP servers), keeps memory in a Wiki, and runs Skills, Automations and Tasks. Clients talk to it over HTTP and SSE on the loopback address. The Arden desktop app (separate repo) starts it as a child process, the `arden` CLI calls it, and you can run it alone or embed it in your own program.

`@arden-hq/protocol` defines the network API. The server builds on `@arden-hq/loop` (the agent loop), `@arden-hq/sqlite-thread`, `@arden-hq/journal`, `@arden-hq/jobs`, `@arden-hq/revisions`, `@arden-hq/prompt-template`, `@arden-hq/answer-ui` and `@arden-hq/relay-protocol`.

## Run

```bash
just server              # from the repository root: build, then start
bun run --cwd apps/server-ts smoke   # build, start on a free port, check /health
```

The server needs Node.js 22.16 or later. It listens on `127.0.0.1:6877` by default. These variables change that:

| Variable | Meaning |
| --- | --- |
| `ARDEN_HOST`, `ARDEN_PORT` | Listen address. The host must be loopback |
| `ARDEN_DATABASE_PATH` | Path of `arden.db` |
| `ARDEN_DIR` | Data folder for the database, Wiki and Skills |
| `ARDEN_VERSION` | Version the server reports |
| `ARDEN_LLAMA_SERVER` | Path of a `llama-server` binary for local models |
| `ARDEN_IDLE_COMPACTION_AFTER_MS` | Idle time before context compaction |

## Embed it

`startServer` starts the same service inside another process. Tests and hosts use it.

```ts
import { startServer } from "@arden-hq/server"

const server = await startServer({ port: 0, databasePath: "/absolute/path/arden.db", provider, modelHost })
const health = await server.fetch("/health")
await server.stop()
```

A custom `runner` replaces only the built-in chat loop. It must yield structured agent events. Plain string streaming is not supported. Context compaction, structured completion and Session naming follow `provider`.

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

## Behavior rules

- **Child agents.** A detached child agent saves its result in a delivery outbox. The server adds it to the pending input of the parent. The loop reads it at the next model step. An idle parent starts a continuation. `agent_message` works only inside one agent family.
- **Tasks in a chat.** A Task with `runs_in: "chat"` takes its next step in its chat as a hidden turn. It spends the Task's token budget. A spent budget stops the Task until the person raises it. Only the person's own turn starts a Task (`task_start`). Other sources use `task_propose`. At most three proposals wait on a Space.
- **Queued messages.** `PUT /sessions/:sessionId/queue` takes `{ "client_ids": [...] }`, the full wanted order. If the queue changed, the server rejects the request and the client must reload.
- **Wiki events.** A Wiki commit is the source of `wiki.changed` events. A queue failure leaves the save done and the event pending. A retry runs every minute.
- **Job classes.** `scheduled_tasks.purpose` is `user_automation`, `space_review`, `task_execution` or `system`. The server never parses a job ID to classify it.
- **Retiring a built-in Automation.** A job with an unknown handler fails at claim. Removing an ID from `SYSTEM_HANDLER_IDS` must ship a numbered migration in the same change. The migration moves its rows off the ID.
- **Detached trace.** A finished detached-agent Session keeps its full trace for 24 hours. Then the server keeps only its identity, lineage, state and final result.

## Layout

`src/` has one folder for each area: `chat`, `tools`, `automations`, `wiki`, `memory`, `sessions`, `work` (Spaces and Tasks), `models`, `providers`, `mcp`, `browser`, `computer`, `persistence`, `http`, `relay`, `mobile`, `prompts` and more. `src/index.ts` is the public entry. `src/main.ts` is the process entry. Prompts are described in `src/prompts/README.md`.

## Build

```bash
bun run --cwd apps/server-ts build
bun run --cwd apps/server-ts typecheck
bun run --cwd apps/server-ts test
```
