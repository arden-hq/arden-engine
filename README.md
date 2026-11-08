# Arden engine

Arden is a personal AI agent that runs on your own computer. You chat with it. It can use your files, a shell, a browser, the web and your Google account to do work for you, and it remembers what matters.

This repository is the open-source engine of Arden. It holds the agent server, the libraries under it, a command-line client and a phone relay. The Arden desktop app (separate repo) is one client of this engine.

## What the server can do

- **Chat.** It runs a model in a loop. The model calls tools until it has an answer. Runs survive a restart.
- **Tools.** Shell commands, file read and write, a browser, web search and fetch, Google (Gmail, Calendar, Drive, Docs) and any MCP server you connect. It can also control native apps on macOS.
- **Memory.** A Wiki of Markdown pages that the agent reads and writes. The file history is kept, so you can restore a page.
- **Skills.** Instructions the agent loads when a task needs them.
- **Automations.** Prompts that run on a schedule or on an event.
- **Spaces and Tasks.** A Space groups chats and Tasks for one area of your work. A Task is a longer job with a token budget.
- **Permissions.** Access to files, commands and the browser goes through rules and approvals. The agent asks you before it does what a rule does not allow.
- **Local models.** The server can download a model and run it with `llama-server` (llama.cpp) for helper work such as search.
- **Phone.** A phone can talk to your Mac through the relay. The relay cannot read the messages.

## How it works

```
 Clients                       Server (apps/server-ts)                  Outside
 -------                       ------------------------                 -------
 Arden desktop app  --\                                              /-- model provider
 arden CLI          ---+-- HTTP + SSE --> chat, tools, memory, ------+--- MCP servers
 your own code      --/    127.0.0.1       automations, Tasks,        \-- Google, web
                                           permissions
 iPhone app --> relay --> (encrypted) -->       |
                                                |
                          loop: runs model turns and tool calls
                                                |
                          storage: arden.db (SQLite) + Wiki files + Skills
```

- The server listens on the loopback address `127.0.0.1`, port `6877` by default. Other computers cannot reach it.
- A client sends requests over HTTP and reads events over SSE (server-sent events). `libs/protocol` defines every route and event.
- When a host app starts the server with a launch token (the capability), each request must carry that token in a header. The desktop app does this. A bare `just server` sets no token, so any local process can call it.
- The server stores its data in the data folder, `~/.arden` by default. Set `ARDEN_DIR` to change it. The main file is `arden.db`. The Wiki is under `memory/wiki` and Skills are under `skills`.
- The model comes from a provider. A host gives one to the server, or the standalone server uses your Codex CLI login. See "Run it".

## Run it

You need [Bun](https://bun.sh), Node.js 22.16 or later, and the [Codex CLI](https://github.com/openai/codex).

```bash
bun install
codex login   # sign in with your ChatGPT account, once
just build    # libraries, server and CLI
just server   # build, then start the server on 127.0.0.1:6877
```

In another terminal, check the server:

```bash
curl http://127.0.0.1:6877/health
# {"status":"ok","version":"0.0.0-dev","has_providers":true}
```

Use `--url` or `ARDEN_URL` to set the server address for the CLI. Use `ARDEN_PORT` and `ARDEN_DIR` to start a second server:

```bash
ARDEN_DIR=/tmp/arden-test ARDEN_PORT=6899 just server
```

### Send a prompt

```bash
node apps/cli/dist/main.js run "Summarize the files in this folder" --url http://127.0.0.1:6877
git diff | node apps/cli/dist/main.js run "Review this diff" --output json
```

`arden run` creates a chat, sends the prompt, waits and prints the answer. Piped input is added to the prompt in a `<stdin>` block. Run `arden --help` for every option.

### The model login

The server reads the Codex CLI login from `$CODEX_HOME/auth.json`, or `~/.codex/auth.json`. It reads the file again for every request. The Codex CLI refreshes the token. The server never writes the file.

If the file is missing or the token expired, the server starts without a model and prints `run codex login`. `/health` then shows `has_providers: false`, and `arden run` stops with `Arden has no model to answer with`.

To use another credential, embed the server. See the next section.

## Embed it

`startServer` starts the server inside your process. It returns a handle with `url`, `fetch`, `replaceProvider`, `drain` and `stop`.

```ts
import { makeOpenAiCodexRuntime, startServer } from "@arden-hq/server"

const runtime = await makeOpenAiCodexRuntime({
  // Your code returns a current ChatGPT access token, and a fresh one when asked to refresh.
  credentials: { get: async ({ forceRefresh }) => ({ accessToken: await myToken(forceRefresh) }) },
  initialCredential: { accessToken: await myToken(false) }
})
if (runtime === null) throw new Error("Could not load the model catalog")

const server = await startServer({
  port: 0, // 0 picks a free port
  databasePath: "/absolute/path/arden.db",
  provider: runtime.provider,
  modelHost: runtime.modelHost,
  refreshModelHost: runtime.refreshModelHost,
  approvalReview: runtime.approvalReview,
  planLimits: runtime.planLimits,
  transcription: runtime.transcription
})
console.log(String(server.url))
await server.stop()
```

The main options of `ServerOptions` (`apps/server-ts/src/config/options.ts`):

| Option | Meaning |
| --- | --- |
| `hostname`, `port` | Listen address. The host must be loopback |
| `databasePath` | The SQLite file. Other data files go beside it. Omit it for an in-memory server for tests (then set `managedOutputRoot`) |
| `provider` | The model provider. Without it, chat answers `unavailable` |
| `modelHost` | The model catalog and defaults, without credentials |
| `runner` | Replaces only the built-in chat loop |
| `sharedSkillRoots` | Extra read-only Skill folders. The default is `~/.agents/skills` |
| `llamaServer` | Path of a `llama-server` binary for local models |
| `idleCompactionAfterMs` | Idle time before the server compacts context |

The server reads these environment variables when it starts as `src/main.ts`: `ARDEN_HOST`, `ARDEN_PORT`, `ARDEN_DIR`, `ARDEN_DATABASE_PATH`, `ARDEN_VERSION`, `ARDEN_LLAMA_SERVER` and `ARDEN_IDLE_COMPACTION_AFTER_MS`.

To call the API from code, use `@arden-hq/headless`:

```ts
import { createHeadlessClient } from "@arden-hq/headless"

const client = createHeadlessClient({ baseUrl: String(server.url) })
const { sessionId } = await client.createSession()
const run = await client.submit({ sessionId, message: "Hello" })
const detail = await client.wait(run)
```

## Repo layout

| Path | Why it exists |
| --- | --- |
| `apps/server-ts` | The agent server, `@arden-hq/server`. It owns chat, tools, memory, automations and storage |
| `apps/cli` | The `arden` command. It sends prompts to a running server (`arden run`) |
| `apps/relay` | Passes sealed messages between a Mac and its phones. It runs on Bun or Cloudflare |
| `libs/loop` | The agent loop: model turns, tool calls and steering, with no Effect dependency |
| `libs/protocol` | The server API contracts: routes, request and response shapes, events and the SSE codec |
| `libs/headless` | A Node client for the server API. The CLI uses it |
| `libs/answer-ui` | The definition of the `arden:ui` answer block (cards, tables, charts) |
| `libs/relay-protocol` | The relay wire format and the end-to-end encryption |
| `libs/journal` | An append-only SQLite log. Readers follow it with their own cursor |
| `libs/jobs` | A worker that runs leased jobs, for schedules and background work |
| `libs/revisions` | Content-addressed file history, for the Wiki |
| `libs/sqlite-thread` | A SQLite client that runs on worker threads, so slow queries do not block the server |
| `libs/prompt-template` | A strict renderer for `{{name}}` prompt templates |
| `libs/std` | Small helpers that every package shares |

Each package has its own `README.md`. `patches/` holds dependency patches. `AGENTS.md` holds the rules for contributors and coding agents.

## Development

```bash
just          # list every recipe
just build    # build libraries, server and CLI
just check    # typecheck, lint, format, dead code, import rules, then all tests
just test     # run every test suite
just release 0.2.0  # set every package to 0.2.0, commit and tag; pushing the tag publishes to npm
```

Run one package: `bun run --cwd apps/server-ts test` or `bun run --cwd libs/loop test`. A database change needs a numbered migration. See `AGENTS.md`.

## Developing with the Arden app

The Arden desktop app (separate repo) imports these packages by name, for example `@arden-hq/protocol`. Without a link it uses the copies installed in its own `node_modules`. `just link` makes it use your local copy.

Run `just link` when you change the engine and want to test it in the app. It runs `bun link` in every package under `libs/` and in `apps/server-ts`. That registers each package with Bun on your machine.

1. In this repo, run `bun install` and `just build`.
2. Run `just link`.
3. In the app checkout, run `just engine local`. It points every engine package at your linked copy and runs `bun install`.
4. Rebuild the engine after each change (`just build`). The app picks up the new build.
5. Before you commit in the app, run `just engine npm` to go back to the published versions. The app's CI fails on a committed local link.

Packages also export their TypeScript source under the `arden-source` condition. A tool that runs source directly takes `--conditions=arden-source`.

## License

Apache License 2.0. See `LICENSE`.
