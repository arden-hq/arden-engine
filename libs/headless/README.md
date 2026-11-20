# `@arden-hq/headless`

A Node client for the HTTP and SSE API of an Arden server. The CLI (`arden run`) uses it.

```ts
import { createHeadlessClient } from "@arden-hq/headless"

const client = createHeadlessClient({ baseUrl: "http://127.0.0.1:3000" })
const { sessionId } = await client.createSession()
const run = await client.submit({ sessionId, message: "Hello" })
const detail = await client.wait(run)
```

## Exports

- `createHeadlessClient(options)` and the `HeadlessClient` class. Options are `baseUrl`, `headers` and `fetch`.
- Sessions: `createSession`, `branchSession`, `listSessions`, `deleteSession`.
- Runs: `submit`, `getRun`, `getRunEvents`, `wait`, `waitForRun`, `cancel`, `listRuns`.
- Messages during a Run: `submit` steers the Run that is going (its result says `delivery: "steered"`); `queue`, `listQueued` and `cancelQueued` park a message until that Run ends.
- Answers: `answerApproval` and `answerConnection` reply to a paused run.
- Models: `listModels` returns the models a new chat may run on, grouped by provider; `createSession({ chat_model })` takes one of their ids.
- Other: `health`, `listSpaces`.
- A server of your own: `startConfiguredServer({ entry, config, env })` starts `main.js --config <settings file>` as a child process and resolves with its ready line (`ConfiguredServerReady` from `@arden-hq/protocol/daemon`, which also says the `provider`, `model` and `contextWindow` a new chat runs on), a `connection` (URL and the secret from its access file) and `stop`. A start that fails rejects with `ConfiguredServerError`, its `reason` read from the server's exit code (`CONFIGURED_SERVER_EXIT`): `"settings"` (exit 2: a settings mistake, an unset key variable, a model the provider does not list), `"provider"` (exit 3: the model server at `provider.baseUrl` did not answer), `"start"` otherwise; the message is the server's own.
- ChatGPT sign-in, from `@arden-hq/headless/chatgpt-login`: `startChatGptLogin()` listens on `127.0.0.1:1455`, returns the authorize `url` (OAuth with PKCE) and resolves `tokens` when the browser comes back; `chatGptCredentials({ store })` hands out an access token and account id, refreshing a token that ends within five minutes and forgetting a login the issuer rejects. The caller chooses where tokens live (`ChatGptLoginStore`); `chatGptLoginFile(folder)` keeps them in `chatgpt-login.json` there, mode 0600.
- Errors: `HeadlessHttpError`, `HeadlessProtocolError`, `HeadlessTimeoutError`, `HeadlessEventHandlerError`, `ConfiguredServerError`.

## Drive a configured server

The settings file is the server's (`apps/server-ts/src/serve/settings.ts` lists every field); this library does not restate it. A local llama.cpp server needs no key:

```ts
import { createHeadlessClient, startConfiguredServer } from "@arden-hq/headless"

// settings.json: { "dataDirectory": "/abs/data",
//   "provider": { "kind": "chat-completions", "baseUrl": "http://127.0.0.1:8080/v1" } }
const server = await startConfiguredServer({
  entry: "/path/to/apps/server-ts/dist/main.js",
  config: "settings.json",
  env: process.env
})
try {
  const client = createHeadlessClient({
    baseUrl: server.connection.url,
    headers: server.connection.headers
  })
  const [model] = (await client.listModels()).providers.flatMap((provider) => provider.models)
  const { session_id } = await client.createSession({ chat_model: model?.id })
  const detail = await client.wait(await client.submit({ sessionId: session_id, message: "Hello" }))
  console.log(detail.model_id, detail.result?.text, detail.result?.usage)
} finally {
  await server.stop()
}
```

A Run that fails ends with `status: "error"` and `error.code`: `provider_unavailable` (the model server stopped answering), `context_length_exceeded` (the prompt is larger than the model's window), `provider_auth` (the key was refused), `model_unavailable`, `rate_limited`. `result.cost` is what the server priced; it prices no call yet, so it is 0 on every provider.

## Rules

- All requests and responses use the contracts of `@arden-hq/protocol`. A bad response throws `HeadlessProtocolError`.
- `submit` retries with the same prepared body, so a retry cannot send the message twice.
- The client sends no credentials by default. Pass them in `headers`.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
