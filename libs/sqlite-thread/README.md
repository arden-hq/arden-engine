# `@arden-hq/sqlite-thread`

An Effect `SqlClient` for SQLite. Its connections run on worker threads. A slow statement or a lock wait blocks that thread and not the caller's event loop.

`@arden-hq/server` uses it for the Arden database.

## Export

`makeSqliteThreadClient(config)` returns the client. It has one write connection. A read-only client can open several connections with `connections`. A statement goes to the least busy one. One slow read does not hold up the others.

## Contract

The client keeps the contract of `@effect/sql-sqlite-node`:

- One serialized connection.
- `BEGIN IMMEDIATE` transactions.
- The same error classification.

When you upgrade that package, compare its `make()` with `src/client.ts`. Check the semaphore, the transaction acquirer and the error classification.

## Files

- `src/client.ts` holds the client.
- `src/thread.ts` holds the worker code. It imports only `node:` modules. Node can load it from source (type stripping) and from `dist`.

## Build

```bash
bun run build
bun run typecheck
```
