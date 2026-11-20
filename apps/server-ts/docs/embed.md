# Embed the server

`startServer` starts the server inside your process. It returns a handle with `url`, `fetch`, `replaceProvider`, `drain` and `stop`. This example signs in with a ChatGPT account.

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

To call the API from code, use `@arden-hq/headless`:

```ts
import { createHeadlessClient } from "@arden-hq/headless"

const client = createHeadlessClient({ baseUrl: String(server.url) })
const { sessionId } = await client.createSession()
const run = await client.submit({ sessionId, message: "Hello" })
const detail = await client.wait(run)
```

A custom `runner` replaces only the built-in chat loop. It must yield structured agent events. Plain string streaming is not supported. Context compaction, structured completion and Session naming follow `provider`.
