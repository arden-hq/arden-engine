# `@arden-hq/server`

The Arden agent server. It runs chats with a model, calls tools, keeps memory in a Wiki, and runs Skills, Automations and Tasks. Clients talk to it over HTTP and SSE on `127.0.0.1`.

## Run

```bash
just build            # from the repository root
just arden login      # sign in with ChatGPT once
just arden serve
```

`arden serve` uses `~/.arden-cli/settings.json`, writing it on first use, and prints the address it runs at. To run the server directly from a settings file of your own:

```bash
node apps/server-ts/dist/main.js --config settings.json
```

When it is ready it prints one JSON line with its `url`. It needs Node.js 22.16 or later.

## Settings file

Only `dataDirectory` is required. It cannot be `~/.arden`.

```json
{
  "dataDirectory": "/abs/trial-1/data",
  "workspace": "/abs/trial-1/work",
  "provider": { "kind": "chat-completions", "baseUrl": "http://127.0.0.1:8080/v1" },
  "tools": ["exec_command", "file_read", "file_write"],
  "approvalMode": "allow",
  "memory": false,
  "automations": false
}
```

`src/serve/settings.ts` lists every field.

## Model providers

| `kind` | Use it for | Needs |
| --- | --- | --- |
| `codex-login` | Your ChatGPT sign-in. The default | `arden login` (or the Codex CLI's `codex login`) |
| `chat-completions` | llama.cpp, OpenRouter, any Chat Completions server | `baseUrl`, and `apiKeyEnv` if the server needs a key |
| `responses` | Any OpenAI Responses endpoint | `baseUrl`, `apiKeyEnv`, `model`, `contextLimit` |
| `codex` | A Codex account with a token that you pass in | `accessTokenEnv` |

A key never goes in the file. The file names the environment variable that holds it.

[docs/providers.md](docs/providers.md) has the details: context windows, output limits, OpenRouter and cost.

## Call it from a program

The server writes its URL and a secret to `cli-access.json` in the data folder. Send the secret in the `x-arden-local-capability` header.

`@arden-hq/headless` wraps the API. `arden exec --config <file> "prompt"` starts a server, runs one prompt and stops.

[docs/drive-from-a-program.md](docs/drive-from-a-program.md) has the details: the ready line, the routes, usage and stop.

## Embed it

`startServer` starts the server inside your process.

```ts
import { startServer } from "@arden-hq/server"

const server = await startServer({ port: 0, databasePath: "/absolute/path/arden.db", provider, modelHost })
const health = await server.fetch("/health")
await server.stop()
```

`ServerOptions` in `src/config/options.ts` lists every option. [docs/embed.md](docs/embed.md) shows how to get `provider` and `modelHost` from a ChatGPT account.

## Where the data is

- `arden.db` holds all product state.
- The Wiki is Markdown under `memory/wiki`.
- Local Skills are under `skills`.

## Develop

```bash
bun run --cwd apps/server-ts build
bun run --cwd apps/server-ts test
bun run --cwd apps/server-ts smoke   # start on a free port and check /health
```

`src/` has one folder for each area, such as `chat`, `tools` and `wiki`. `src/index.ts` is the public entry and `src/main.ts` is the process entry.

Before you change the server, read [docs/behavior-rules.md](docs/behavior-rules.md) and the repository's `AGENTS.md`.
