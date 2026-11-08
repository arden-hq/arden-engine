import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import {
  JournalError,
  initializeJournalSchema,
  makeJournalRuntime,
  type JournalRuntime,
  type JournalRuntimeOptions
} from "../src/effect/runtime.js"

const withJournal = async <A, E>(
  label: string,
  options: JournalRuntimeOptions,
  body: (journal: JournalRuntime) => Effect.Effect<A, E>
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), label))
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* initializeJournalSchema(sql)
          const journal = yield* makeJournalRuntime(sql, { ...options, initialize: false })
          return yield* body(journal)
        }).pipe(
          Effect.provide(
            SqliteClient.layer({
              filename: join(directory, "journal.sqlite")
            })
          )
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const inJournalFile = <A, E>(
  filename: string,
  body: (journal: JournalRuntime) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const journal = yield* makeJournalRuntime(sql)
        return yield* body(journal)
      }).pipe(Effect.provide(SqliteClient.layer({ filename })))
    )
  )

const readAll = (journal: JournalRuntime, streamId: string) =>
  journal.watermarks(streamId).pipe(
    Effect.flatMap(({ headSequence }) =>
      journal.readPage({
        streamId,
        afterSequence: 0,
        throughSequence: headSequence
      })
    )
  )

describe("Effect journal storage", () => {
  it("persists durable records across reopen and never replays live-only records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-journal-reopen-"))
    const filename = join(directory, "journal.sqlite")
    try {
      const written = await inJournalFile(filename, (journal) =>
        Effect.gen(function* () {
          const first = yield* journal.append("chat-1", [
            { type: "run_started", data: { runId: "run-1" } },
            { type: "text_delta", data: { delta: "hi" }, durable: false }
          ])
          const read = yield* readAll(journal, "chat-1")
          const rejected = yield* journal
            .append("chat-1", [
              { type: "text_delta", data: {}, durable: false },
              { type: "run_finished", data: {} }
            ])
            .pipe(Effect.flip)
          const last = yield* journal.append("chat-1", [{ type: "run_finished", data: {} }])
          return { first, read, rejected, last }
        })
      )
      expect(written.first.records.map((record) => [record.sequence, record.durable])).toEqual([
        [1, true],
        [2, false]
      ])
      expect(written.read.map((record) => record.sequence)).toEqual([1])
      expect(written.rejected).toBeInstanceOf(JournalError)
      expect(written.rejected).toMatchObject({ operation: "append", kind: "invalid_input" })
      expect(written.last.records[0]?.sequence).toBe(3)

      const reopened = await inJournalFile(filename, (journal) => readAll(journal, "chat-1"))
      expect(reopened.map((record) => [record.sequence, record.type])).toEqual([
        [1, "run_started"],
        [3, "run_finished"]
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("Effect journal follower", () => {
  it("attaches before the latest watermark and coalesces the seam instead of overflowing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-journal-follow-seam-"))
    try {
      const deliveries = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* initializeJournalSchema(sql)
            const watermarkRead = yield* Deferred.make<void>()
            const releaseWatermark = yield* Deferred.make<void>()
            let blockNextWatermark = true
            const gatedSql = new Proxy(sql, {
              apply(target, thisArg, argumentsList) {
                const strings = argumentsList[0]
                const statement = Array.isArray(strings) ? strings.join("?") : ""
                const query = Reflect.apply(target, thisArg, argumentsList)
                if (
                  blockNextWatermark &&
                  statement.includes("SELECT head_sequence, retained_from_sequence")
                ) {
                  blockNextWatermark = false
                  return Deferred.succeed(watermarkRead, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseWatermark)),
                    Effect.andThen(query)
                  )
                }
                return query
              }
            })
            const journal = yield* makeJournalRuntime(gatedSql, {
              initialize: false,
              subscriberCapacity: 2
            })
            const opening = yield* journal
              .openFollow({
                streamId: "session-1",
                startAt: "latest"
              })
              .pipe(Effect.forkChild)

            yield* Deferred.await(watermarkRead)
            yield* journal.append("session-1", [
              {
                type: "text_delta",
                data: { delta: "first" },
                durable: false
              }
            ])
            yield* journal.append("session-1", [
              {
                type: "text_delta",
                data: { delta: "second" },
                durable: false
              }
            ])
            yield* Deferred.succeed(releaseWatermark, undefined)

            const opened = yield* Fiber.join(opening)
            yield* journal.append("session-1", [
              {
                type: "text_end",
                data: { content: "first second" }
              }
            ])
            const values = yield* Effect.timeout(
              Stream.runCollect(opened.stream.pipe(Stream.take(1))),
              "1 second"
            )
            return { initialSequence: opened.initialSequence, values }
          }).pipe(
            Effect.provide(
              SqliteClient.layer({
                filename: join(directory, "journal.sqlite")
              })
            )
          )
        )
      )

      expect(deliveries.initialSequence).toBe(2)
      expect(deliveries.values).toHaveLength(1)
      const delivery = deliveries.values[0]
      expect(delivery?.kind).toBe("record")
      if (delivery?.kind !== "record") throw new Error("expected a record delivery")
      expect(delivery.record.sequence).toBe(3)
      expect(delivery.record.type).toBe("text_end")
      expect(delivery.replayed).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { subscriberCapacity: 2, subscriberByteCapacity: 100_000, batches: [2, 1], text: "x" },
    { subscriberCapacity: 2, subscriberByteCapacity: 100_000, batches: [3], text: "x" },
    {
      subscriberCapacity: 100,
      subscriberByteCapacity: 1_000,
      batches: [1, 1],
      text: "界".repeat(200)
    }
  ])(
    "bounds records and UTF-8 bytes even inside one coalesced slot: %j",
    async ({ batches, text, ...options }) => {
      const deliveries = await withJournal("arden-journal-payload-budget-", options, (journal) =>
        Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* journal.openFollow({ streamId: "s", afterSequence: 0 })
            for (const count of batches) {
              yield* journal.append(
                "s",
                Array.from({ length: count }, () => ({ type: "delta", data: text, durable: false }))
              )
            }
            return yield* Effect.timeout(Stream.runCollect(opened.stream), "1 second")
          })
        )
      )
      expect(deliveries).toEqual([{ kind: "overflow", cursor: 0 }])
    }
  )

  it("still reports a bounded overflow when tier switches exceed the capacity", async () => {
    const deliveries = await withJournal(
      "arden-journal-overflow-",
      { subscriberCapacity: 1 },
      (journal) =>
        Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* journal.openFollow({
              streamId: "session-1",
              afterSequence: 0
            })
            yield* journal.append("session-1", [
              {
                type: "text_delta",
                data: { delta: "first" },
                durable: false
              }
            ])
            yield* journal.append("session-1", [
              {
                type: "text_end",
                data: { content: "first" }
              }
            ])
            return yield* Effect.timeout(Stream.runCollect(opened.stream), "1 second")
          })
        )
    )

    expect(deliveries).toEqual([{ kind: "overflow", cursor: 0 }])
  })

  it("delivers interleaved tiers in sequence order across sealed tails", async () => {
    const deliveries = await withJournal("arden-journal-interleave-", {}, (journal) =>
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* journal.openFollow({
            streamId: "session-1",
            afterSequence: 0
          })
          yield* journal.append("session-1", [
            {
              type: "text_delta",
              data: { delta: "a" },
              durable: false
            }
          ])
          yield* journal.append("session-1", [
            {
              type: "text_end",
              data: { content: "a" }
            }
          ])
          yield* journal.append("session-1", [
            {
              type: "text_delta",
              data: { delta: "b" },
              durable: false
            }
          ])
          return yield* Effect.timeout(
            Stream.runCollect(opened.stream.pipe(Stream.take(3))),
            "1 second"
          )
        })
      )
    )

    expect(
      deliveries.map((delivery) =>
        delivery.kind === "record"
          ? {
              sequence: delivery.record.sequence,
              type: delivery.record.type,
              durable: delivery.record.durable
            }
          : { kind: delivery.kind }
      )
    ).toEqual([
      { sequence: 1, type: "text_delta", durable: false },
      { sequence: 2, type: "text_end", durable: true },
      { sequence: 3, type: "text_delta", durable: false }
    ])
  })
})
