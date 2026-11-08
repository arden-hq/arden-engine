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
- Runs: `submit`, `getRun`, `getRunEvents`, `wait`, `waitForRun`, `cancel`.
- Answers: `answerApproval` and `answerConnection` reply to a paused run.
- Other: `health`, `listSpaces`.
- Errors: `HeadlessHttpError`, `HeadlessProtocolError`, `HeadlessTimeoutError`, `HeadlessEventHandlerError`.

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
