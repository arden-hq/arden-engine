# `@arden-hq/journal`

An append-only SQLite log of ordered records, one log per stream. It is for Effect programs that already own a SQLite `SqlClient`. `@arden-hq/server` uses it.

Publishers append. Each reader follows with its own cursor. It is not a work queue. It does not store reader offsets.

Import from `@arden-hq/journal/effect`. There is no root entry. Effect is a peer dependency.

```ts
import { makeJournalRuntime } from "@arden-hq/journal/effect"

const journal = yield* makeJournalRuntime(yield* SqlClient.SqlClient)
yield* journal.append("session-1", [{ type: "run_started", data: { runId: "run-1" } }])
yield* Stream.runForEach(journal.follow({ streamId: "session-1" }), handle)
```

## Records and followers

- Each stream has a sequence that starts at `1` and only grows.
- Durable records go to SQLite. Transient records get a sequence but only reach connected followers.
- A follower rereads durable rows after each wake. A lost wake cannot lose a durable record.
- `follow` replays from the start, then stays live. Use `startAt: "latest"` for new records only. Use `afterSequence` to reconnect. `openFollow` returns when the follower is attached.
- Delivery is at least once. Use `streamId` plus `sequence` to drop duplicates.
- `readPage` reads a range. `watermarks` gives the head.
- `subscriberCapacity` (default 4096) and `subscriberByteCapacity` (default 8 MiB) bound the queue of a follower. On overflow, only that follower closes. It gets its cursor so it can resync.

## Shared database helpers

`appendInTransaction` writes journal rows only. The caller owns the transaction. Notify after it commits. If other writers use the same database, run the append and the notify in commit order.

Other tables reach journal storage only through these helpers. Each joins the caller's transaction:

- `readHeadSequence`
- `retainFromInTransaction`
- `deleteStreamInTransaction`
- `truncateBeforeInTransaction`
- `journalRecordsSql` and `journalHeadSequenceSql` for custom queries

## Not included

Event IDs, idempotency, pruning policy, consumer groups, brokers and protocol schemas. Live notices stay in one process. SQLite is the source of truth.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
