# `@arden-hq/protocol`

The contracts of the Arden server API: routes, request builders, response decoders, event types and the SSE codec. The server, the CLI, `@arden-hq/headless` and the desktop app import it. It is the one place where the wire shape of the API is written down.

Plain entry points are ordinary TypeScript. They work in Node, Bun, Electron and a browser. Effect schemas live in separate `effect/` entry points that only the server uses. Effect is a peer dependency.

## Entry points

| Import | What it gives you |
| --- | --- |
| `@arden-hq/protocol` | `ProtocolError`, `normalizeApiError`, the server event types and the SSE codec |
| `@arden-hq/protocol/<domain>` | The routes, request builders, decoders and types of one domain |
| `@arden-hq/protocol/effect/<domain>` | The Effect schemas of that domain (server only) |
| `@arden-hq/protocol/daemon` and `/daemon/effect` | The private boundary between Electron and the daemon |

Each domain folder in `src/` has the same shape:

- `<domain>Routes` holds the route paths.
- `<domain>Requests` builds a request body and validates it before it is serialized.
- `<domain>Decoders` decodes a response. A bad response throws `ProtocolError`.
- `schema.ts` holds the Effect schemas. `index.ts` holds the plain decoders, routes and types.

Domains are `chat`, `sessions`, `runs`, `models`, `config`, `context`, `permissions`, `tools`, `skills`, `wiki`, `spaces`, `automations`, `inbox`, `google`, `mcp`, `storage`, `health`, `notifications`, `mobile`, `relay`, `local-models`, `embeddings` and more. Read `src/<domain>/index.ts` for the exact exports.

## Example

```ts
import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"

const message = chatRequests.message({ sessionId: "session-1", message: "Hello" })
const response = await fetch(chatRoutes.message, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: message.body
})
const receipt = chatDecoders.receipt(await response.json())
```

Send `message.body` again, unchanged, if the request must be retried. It holds a private client ID that makes the retry safe.

## Server-Sent Events

- `decodeServerEventStream(source)` decodes a live stream of text or UTF-8 chunks. A chunk may end inside a multi-byte character. Returning the iterator closes the stream.
- `decodeServerEventStreamBuffer(text)` decodes a payload that is already in memory.
- `decodeSseFrames(text)` returns raw frames with no event validation.
- `encodeServerEventFrame(event)` writes one frame.
- Pass `onRetry` to see an SSE `retry:` line. A live decoder then ends cleanly so the transport can reconnect.
- `chatRoutes.events(sessionId)` is the stream of a session: a snapshot, then a live tail.

## Rules

- Mutation inputs use camelCase. Routes and decoders are the only place a wire shape is written. A client never builds a body by hand.
- A decoder is `decoderFor(schema, message)`. A schema behind a hand-written interface is typed `Schema.Codec<Interface>`, so the two cannot drift.
- Durable events accept new unknown fields. An older client can read a newer event. Commands and results that cross a device boundary stay strict.
- Public projections drop server internals. For example, health shows status, version and provider availability only.
- The desktop app and the server ship together. The settings decoder needs the current server contract.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
