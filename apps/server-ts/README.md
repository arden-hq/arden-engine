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

## Drive it from another program

A benchmark adapter, an RL environment or a CI job needs a server that is set up before the first message and that it alone owns. Start one from a settings file:

```bash
node apps/server-ts/dist/main.js --config settings.json   # or: arden serve --config settings.json
```

```json
{
  "dataDirectory": "/abs/trial-1/data",
  "provider": { "kind": "responses", "baseUrl": "https://api.example.com/v1", "apiKeyEnv": "MODEL_KEY" },
  "model": "some-model",
  "contextLimit": 200000,
  "maxSteps": 100,
  "maxModelRequests": 500,
  "tools": ["exec_command", "file_read", "file_write"],
  "workspace": "/abs/trial-1/work",
  "approvalMode": "allow",
  "memory": false,
  "automations": false
}
```

- **Providers.** `responses` is any OpenAI Responses endpoint (`baseUrl`, `apiKeyEnv`; needs `model` and `contextLimit`). `chat-completions` is any OpenAI Chat Completions endpoint: llama.cpp's `llama-server`, OpenRouter, or another. `apiKeyEnv` is optional (a local server has no key). `server` (`llama.cpp`, `openrouter`, `generic`) is detected at start when absent: `openrouter.ai` by its host, llama.cpp by `GET /props`. llama.cpp and OpenRouter report each model's context window, reasoning efforts and request shape; `contextLimit` may only lower that window. A llama.cpp server with one model needs no `model`; OpenRouter needs `model`; a generic server needs `model` and `contextLimit`. `codex` and `codex-login` use a Codex account.

  ```json
  { "provider": { "kind": "chat-completions", "baseUrl": "http://127.0.0.1:8080/v1" } }
  { "provider": { "kind": "chat-completions", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }, "model": "openai/gpt-4o-mini" }
  ```

  A Chat Completions route searches tools on the client, as the Responses route does: the model is offered the core tools and one search tool, and a found tool is declared from the next request on. Measured on llama.cpp b12359 with Gemma 4 on 2026-11-16, the first request is about 14,100 tokens: 8,400 for the 22 core tools, 4,600 for the system prompt and runtime context, 1,100 for the search tool. With `toolSearch: false` every tool is declared and the request is about 56,000 tokens. A window near the request size compacts after every step, so give a local model at least 32,768 tokens, or offer fewer tools with `tools`. A model with a smaller window than the request fails with `context_length_exceeded`. A route whose model takes images (llama.cpp with a multimodal projector, an OpenRouter vision model) reports it, so `file_read` and attachments send images there at their stored size, converted to PNG or JPEG: neither server states limits to fit them to. A text-only route gets a note that an image was left out. To check a local model end to end:

  ```bash
  llama-server -m model.gguf --ctx-size 32768 --port 8080 &
  cat > /tmp/arden-cc/settings.json <<EOF
  { "dataDirectory": "/tmp/arden-cc/data", "workspace": "/tmp/arden-cc/work",
    "provider": { "kind": "chat-completions", "baseUrl": "http://127.0.0.1:8080/v1" },
    "tools": ["exec_command"], "approvalMode": "allow", "memory": false, "automations": false, "skillRoots": [] }
  EOF
  node apps/server-ts/dist/main.js --config /tmp/arden-cc/settings.json &   # prints the ready line
  ARDEN_DIR=/tmp/arden-cc/data node apps/cli/dist/main.js run --output json "Run \`echo ok\` with exec_command and say what it printed."
  sqlite3 /tmp/arden-cc/data/arden.db "select json_extract(message_json, '$.origin') from session_messages where role = 'assistant'"
  ```

  Thinking counts against the output limit on every server, and a side job (a chat name, a task description, a review, triage, a compaction summary) has a small budget for its answer. So a one-answer side job runs at effort `none` where the model offers it, unless an effort is set for the helper model, and otherwise its limit leaves 4,096 more tokens for thinking, never more than the model's own output cap (OpenRouter's `max_completion_tokens`) (`src/models/side-call.ts`). A route that sends no output limit (Codex) keeps the model's default effort: thinking cannot cut its answer short. llama.cpp offers `none` for every model: the server turns the template's thinking off, so the chat may pick it too. OpenRouter offers it where the model's reasoning is not mandatory.
- **Settings.** Only `dataDirectory` is required, and it may not be `~/.arden`. `src/serve/settings.ts` lists every field with its meaning: provider and models, step and request limits, tools, sub-agents, approval mode, whether a person follows the chats (`userFacing`), compaction, Memory, Automations, MCP servers, Skills, the command sandbox. A key is never in the file; the file names the environment variable that holds it. A mistake exits with code 2 and one line that names the field.
- **Ready line.** When every setting is in place the server prints one JSON line on stdout: `type: "ready"`, `url`, `dataDirectory`, `accessFile`, `usageFile`, `offeredTools`, `toolsWithoutRule`, `mcpServers`. Nothing else goes to stdout; the log goes to stderr.
- **Access.** `accessFile` (`cli-access.json` in the data folder) holds the server URL and a secret. Send the secret as the `x-arden-local-capability` header. It is the owner's secret: whoever started the server reaches every route. `arden run`, `arden wait` and `arden sessions` find the file with `ARDEN_DIR=<dataDirectory>`.
- **Turns.** `POST /chat/message` starts a Run and returns its id at once; `GET /chat/runs/:id` and the event stream say when it ended and carry text, usage and steps. A message sent while a Run is going joins it and the receipt says `delivery: "steered"`. A message that must wait for the Run to end goes to `POST /sessions/:id/queue`. `POST /cancel` interrupts. `GET /chat/runs` lists every Run, sub-agent Runs included, and says whether the server is `idle`. `@arden-hq/headless` wraps all of these.
- **Usage.** `usageFile` holds the model requests and tokens of the whole data folder, sub-agents and side jobs included, rewritten after every request. Past `maxModelRequests` the next request fails and the file says `budgetExhausted`.
- **Stop.** SIGINT or SIGTERM stops the server cleanly and removes the access file. A later start on the same data folder applies the settings file again and goes on counting usage.
- **One prompt.** `arden exec --config settings.json "prompt"` does all of it: start, one Run, a JSON receipt, stop.

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
