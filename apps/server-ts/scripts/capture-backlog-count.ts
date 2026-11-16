// Counts, on the replay copy and with no model, what a catch-up of Memory Capture's old unread
// turns would take: the batches Capture would hand a model if it read every closed unread range, and
// the typed owner turns in those ranges, split at 28 Aug 2026, when the old marks began. Batches
// come from Capture's own reader, so the count follows Capture's limits wherever they change.
//
// Run it with `just capture-backlog <replay folder>`. It runs under vitest, which resolves the
// engine's TypeScript sources, and opens the copy only through test/fixtures/replay-copy.ts. The
// backfill of old unread turns runs first, as at server start, inside a transaction that is rolled back.

import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { it } from "vitest"
import { readCaptureBatch, type CaptureRead } from "../src/memory/capture-batches.js"
import type { MemoryCapturePosition } from "../src/persistence/memory/store.js"
import {
  memoryCaptureBacklogBackfill,
  TYPED_TURN
} from "../src/persistence/sqlite/memory-capture-backlog-backfill.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { makeTranscriptQueries } from "../src/persistence/sqlite/transcript.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import {
  locateReplayCopy,
  rollBackOnReplayCopy,
  runOnReplayCopy
} from "../test/fixtures/replay-copy.js"

const SPLIT_AT = "2026-08-28T00:00:00.000Z"

interface Side {
  /** Batches a model would review: one Capture run each. */
  readonly batches: number
  readonly typedTurns: number
  /**
   * Typed turns only in batches Capture passes without a model: their runs recorded no origin,
   * so Capture cannot tell the owner's words from an Automation's and treats them as unverified.
   */
  readonly typedTurnsPassed: number
}

it("counts the Capture runs a catch-up of the old unread turns would take", async () => {
  const located = locateReplayCopy()
  if (located.kind === "absent") throw new Error(located.reason)
  // Opening the copy the way the server does runs any pending migration on it first.
  await runOnReplayCopy(located.copy, Effect.void)
  const counted = await rollBackOnReplayCopy(located.copy, (sql) =>
    count(sql).pipe(Effect.provide(PersistenceWriteQueue.layer))
  )
  const line = (label: string, side: Side) =>
    `${label}: ${side.batches} Capture runs; ${side.typedTurns} typed owner turns, ` +
    `${side.typedTurnsPassed} of them passed without a model.`
  // Vitest swallows console output here; a direct write reaches the terminal.
  process.stdout.write(
    [
      `Closed unread ranges: ${counted.ranges}.`,
      line("Before 28 Aug 2026", counted.before),
      line("Since 28 Aug 2026", counted.since),
      `Batches with nothing to review, which Capture passes without a model: ${counted.passed}.`,
      ""
    ].join("\n")
  )
}, 3_600_000)

const count = Effect.fn("countCaptureBacklog")(function* (sql: SqlClient.SqlClient) {
  for (let cursor: string | undefined = undefined, rounds = 0; rounds < 100_000; rounds += 1) {
    const chunk: { readonly next: string | undefined } = yield* memoryCaptureBacklogBackfill
      .chunk({ cursor, limit: 200 })
      .pipe(Effect.provideService(SqlClient.SqlClient, sql))
    cursor = chunk.next
    if (cursor === undefined) break
  }
  const transcript = makeTranscriptQueries({
    reader: sql,
    writer: makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
  })
  const ranges = yield* sql<{
    readonly session_id: string
    readonly read_seq: number
    readonly through_seq: number
  }>`SELECT session_id, read_seq, through_seq FROM memory_capture_unread
    WHERE through_seq IS NOT NULL ORDER BY session_id, read_seq`
  const typed = yield* sql<{
    readonly session_id: string
    readonly message_id: string
    readonly before: number
  }>`
    SELECT message.session_id, message.message_id, message.created_at < ${SPLIT_AT} AS before
    FROM memory_capture_unread AS unread
    JOIN session_messages AS message ON message.session_id = unread.session_id
      AND message.seq BETWEEN unread.read_seq + 1 AND unread.through_seq
    WHERE ${sql.literal(TYPED_TURN)}`
  const key = (sessionId: string, messageId: string) => `${sessionId} ${messageId}`
  const typedBefore = new Map(typed.map((row) => [key(row.session_id, row.message_id), row.before]))
  const reviewed = new Set<string>()
  const batches = { before: 0, since: 0 }
  let passed = 0
  for (const range of ranges) {
    let start: MemoryCapturePosition =
      range.read_seq < 0
        ? { _tag: "Beginning" }
        : { _tag: "AfterSequence", sequence: range.read_seq }
    for (;;) {
      const read: CaptureRead | undefined = yield* readCaptureBatch(transcript, {
        sessionId: range.session_id,
        start,
        stop: undefined,
        last: range.through_seq
      })
      if (read === undefined) break
      const first = read.excerpts[0]
      if (!read.reviewable || first === undefined) passed += 1
      else {
        if (DateTime.formatIso(first.record.createdAt) < SPLIT_AT) batches.before += 1
        else batches.since += 1
        for (const excerpt of read.excerpts)
          reviewed.add(key(range.session_id, excerpt.record.messageId))
      }
      start = read.end
    }
  }
  const side = (before: 0 | 1, batchCount: number): Side => {
    const ids = [...typedBefore].filter(([, side]) => side === before).map(([id]) => id)
    return {
      batches: batchCount,
      typedTurns: ids.length,
      typedTurnsPassed: ids.filter((id) => !reviewed.has(id)).length
    }
  }
  return {
    ranges: ranges.length,
    before: side(1, batches.before),
    since: side(0, batches.since),
    passed
  }
})
