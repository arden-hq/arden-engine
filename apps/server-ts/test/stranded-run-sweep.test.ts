import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"
import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { startServer } from "../src/index.js"
import { isRunAlreadyTerminal, persistRunTerminal } from "../src/chat/terminal-write.js"
import { ChatWriteError, ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { decodeRow } from "./kit.js"

const persistence = (filename: string) =>
  recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )

const startRun = (chat: ChatWriteStore["Service"], sessionId: string, clientId: string) =>
  chat.start({
    sessionId,
    clientId,
    requestHash: `${clientId}-hash`,
    assistantMessageId: `${clientId}-assistant`,
    message: {
      message_id: clientId,
      client_id: clientId,
      role: "user",
      content: "Begin",
      created_at: "2026-09-01T00:00:00.000Z"
    }
  })

const RunRecordSchema = Schema.Struct({
  status: Schema.String,
  stop_reason: Schema.NullOr(Schema.String),
  error_code: Schema.NullOr(Schema.String),
  error_message: Schema.NullOr(Schema.String)
})

const readRun = (database: DatabaseSync, runId: string) =>
  decodeRow(
    RunRecordSchema,
    database
      .prepare(
        "SELECT status, stop_reason, error_code, error_message FROM chat_runs WHERE run_id = ?"
      )
      .get(runId)
  )

const readEventTypes = (database: DatabaseSync, runId: string) =>
  database
    .prepare(
      `SELECT event_type FROM journal_records
     WHERE json_extract(attributes_json, '$.runId') = ? ORDER BY sequence`
    )
    .all(runId)
    .map((row) => row.event_type)

const readResumeCauses = (database: DatabaseSync, runId: string) => {
  const row = decodeRow(
    Schema.Struct({ resumed: Schema.NullOr(Schema.String) }),
    database
      .prepare(
        "SELECT json_extract(metadata_json, '$.resumed') AS resumed FROM chat_runs WHERE run_id = ?"
      )
      .get(runId)
  )
  return (JSON.parse(row.resumed ?? "[]") as Array<{ readonly cause: string }>).map(
    (entry) => entry.cause
  )
}

describe("stranded Chat runs", () => {
  it("retries a transient terminal write until it lands", async () => {
    let attempts = 0
    const write = Effect.suspend(() => {
      attempts += 1
      return attempts < 3
        ? Effect.fail(
            new ChatWriteError({
              operation: "fail",
              reason: "storage",
              message: "database is locked"
            })
          )
        : Effect.succeed("terminal")
    })

    const outcome = await Effect.runPromise(persistRunTerminal(write))

    expect(attempts).toBe(3)
    expect(Result.isSuccess(outcome) && outcome.success).toBe("terminal")
  })

  it("stops at a run that already carries another path's terminal write", async () => {
    let attempts = 0
    const write = Effect.suspend(() => {
      attempts += 1
      return Effect.fail(
        new ChatWriteError({
          operation: "fail",
          reason: "terminal",
          message: "Chat run is already terminal"
        })
      )
    })

    const outcome = await Effect.runPromise(persistRunTerminal(write))

    expect(attempts).toBe(1)
    expect(Result.isFailure(outcome) && isRunAlreadyTerminal(outcome.failure)).toBe(true)
  })

  it("re-arms a run with no executor and leaves an owned run running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-stranded-sweep-"))
    const filename = join(directory, "arden.db")

    try {
      const runs = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionStore
          const chat = yield* ChatWriteStore
          const owned = yield* sessions.create({ name: "Owned" })
          const stranded = yield* sessions.create({ name: "Stranded" })
          const ownedRun = yield* startRun(chat, owned.sessionId, "owned-user")
          const strandedRun = yield* startRun(chat, stranded.sessionId, "stranded-user")
          if (ownedRun._tag !== "Started" || strandedRun._tag !== "Started") {
            return yield* Effect.die("Chat runs did not start")
          }
          const closed = yield* chat.interruptStranded({ ownedRunIds: [ownedRun.runId] })
          return { closed, owned: ownedRun.runId, stranded: strandedRun.runId }
        }).pipe(Effect.provide(persistence(filename)))
      )

      expect(runs.closed).toEqual([])

      const database = new DatabaseSync(filename, { readOnly: true })
      const strandedRun = readRun(database, runs.stranded)
      const ownedRun = readRun(database, runs.owned)
      const strandedTypes = readEventTypes(database, runs.stranded)
      const ownedTypes = readEventTypes(database, runs.owned)
      const strandedCauses = readResumeCauses(database, runs.stranded)
      database.close()

      expect(strandedRun).toEqual({
        status: "pending",
        stop_reason: null,
        error_code: null,
        error_message: null
      })
      expect(strandedCauses).toEqual(["abandoned"])
      expect(strandedTypes).toEqual(["RUN_STARTED", "TEXT_MESSAGE_START"])
      expect(ownedRun).toMatchObject({ status: "running", error_code: null })
      expect(ownedTypes).toEqual(["RUN_STARTED", "TEXT_MESSAGE_START"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("boots past a run whose recovery fails, quarantining only that run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-recovery-quarantine-"))
    const filename = join(directory, "arden.db")

    try {
      const runs = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionStore
          const chat = yield* ChatWriteStore
          const damaged = yield* sessions.create({ name: "Damaged" })
          const healthy = yield* sessions.create({ name: "Healthy" })
          const damagedRun = yield* startRun(chat, damaged.sessionId, "damaged-user")
          const healthyRun = yield* startRun(chat, healthy.sessionId, "healthy-user")
          if (damagedRun._tag !== "Started" || healthyRun._tag !== "Started") {
            return yield* Effect.die("Chat runs did not start")
          }
          return {
            damaged: damagedRun.runId,
            damagedSession: damaged.sessionId,
            healthy: healthyRun.runId
          }
        }).pipe(Effect.provide(persistence(filename)))
      )

      const writable = new DatabaseSync(filename)
      writable
        .prepare(
          `UPDATE chat_runs
           SET metadata_json = json_set(metadata_json, '$.cancelled_by_run_id', run_id)
           WHERE run_id IN (?, ?)`
        )
        .run(runs.damaged, runs.healthy)
      writable
        .prepare(
          "UPDATE sessions SET active_message_count = active_message_count + 7 WHERE session_id = ?"
        )
        .run(runs.damagedSession)
      writable.close()

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* ChatWriteStore
        }).pipe(Effect.provide(persistence(filename)))
      )

      const database = new DatabaseSync(filename, { readOnly: true })
      const damaged = readRun(database, runs.damaged)
      const healthy = readRun(database, runs.healthy)
      const damagedTypes = readEventTypes(database, runs.damaged)
      database.close()

      expect(damaged).toMatchObject({
        status: "interrupted",
        stop_reason: "recovery_failed",
        error_code: "run_interrupted"
      })
      expect(damagedTypes.at(-1)).toBe("RUN_ERROR")
      expect(healthy).toMatchObject({ status: "cancelled", stop_reason: "cancelled" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("re-arms a stranded run the same way a reboot does", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-stranded-parity-"))
    const filename = join(directory, "arden.db")

    try {
      const runs = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionStore
          const chat = yield* ChatWriteStore
          const swept = yield* sessions.create({ name: "Swept" })
          const rebooted = yield* sessions.create({ name: "Rebooted" })
          const sweptRun = yield* startRun(chat, swept.sessionId, "swept-user")
          const rebootedRun = yield* startRun(chat, rebooted.sessionId, "rebooted-user")
          if (sweptRun._tag !== "Started" || rebootedRun._tag !== "Started") {
            return yield* Effect.die("Chat runs did not start")
          }
          yield* chat.interruptStranded({ ownedRunIds: [rebootedRun.runId] })
          return { swept: sweptRun.runId, rebooted: rebootedRun.runId }
        }).pipe(Effect.provide(persistence(filename)))
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* ChatWriteStore
        }).pipe(Effect.provide(persistence(filename)))
      )

      const database = new DatabaseSync(filename, { readOnly: true })
      const swept = readRun(database, runs.swept)
      const rebooted = readRun(database, runs.rebooted)
      const sweptTypes = readEventTypes(database, runs.swept)
      const rebootedTypes = readEventTypes(database, runs.rebooted)
      const sweptCauses = readResumeCauses(database, runs.swept)
      const rebootedCauses = readResumeCauses(database, runs.rebooted)
      database.close()

      expect(rebooted).toEqual({
        status: "pending",
        stop_reason: null,
        error_code: null,
        error_message: null
      })
      expect(swept).toEqual(rebooted)
      expect(sweptTypes).toEqual(rebootedTypes)
      expect(rebootedTypes).toEqual(["RUN_STARTED", "TEXT_MESSAGE_START"])
      expect([sweptCauses, rebootedCauses]).toEqual([["abandoned"], ["server_restart"]])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps a cancelled run terminal when the runner fails on the abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-abort-race-"))
    const databasePath = join(directory, "arden.db")
    let markStarted: () => void = () => {}
    let markAborted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve
    })
    const server = await startServer({
      port: 0,
      databasePath,
      runner: async function* ({ signal }) {
        markStarted()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        markAborted()
        throw new Error("Provider stream failed after the abort")
      }
    })

    try {
      const created = (await server
        .fetch("/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Abort race" })
        })
        .then((response) => response.json())) as { readonly session_id: string }
      const receipt = chatDecoders.receipt(
        await server
          .fetch(chatRoutes.message, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: chatRequests.message({ sessionId: created.session_id, message: "Start" }).body
          })
          .then((response) => response.json())
      )
      if (receipt.runId === null) throw new Error("Chat receipt did not include a run id")
      await started

      await server.fetch(chatRoutes.cancel, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatRequests.cancel({ runId: receipt.runId })
      })
      await aborted
      await server.stop()

      const database = new DatabaseSync(databasePath, { readOnly: true })
      const run = readRun(database, receipt.runId)
      const types = readEventTypes(database, receipt.runId)
      database.close()

      expect(run).toMatchObject({ status: "cancelled", stop_reason: "cancelled" })
      expect(types.filter((type) => type === "run_cancelled")).toHaveLength(1)
      expect(types).not.toContain("RUN_ERROR")
    } finally {
      await server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
