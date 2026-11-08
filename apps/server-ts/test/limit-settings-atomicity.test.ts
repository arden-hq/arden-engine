import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { makeLimitSettingsStore } from "../src/persistence/sqlite/limit-settings.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"

it.each([100, null])(
  "persists a background stop of %s and rolls back a failed change",
  async (backgroundLimitPercent) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const queue = yield* PersistenceWriteQueue
          yield* sql`CREATE TABLE monitor_state (namespace TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)`
          yield* sql`CREATE TABLE chat_runs (status TEXT NOT NULL, metadata_json TEXT NOT NULL)`
          const paused = JSON.stringify({
            quota_pause: { reason: "plan_used_up", until: "2099-01-01T00:00:00Z" }
          })
          yield* sql`INSERT INTO chat_runs VALUES ('pending', ${paused})`
          const store = yield* makeLimitSettingsStore({
            writer: makeWriter({ sql, reader: sql, queue }),
            sessionEvents: { appendEventInTransaction: () => Effect.die("no notice is recorded") }
          })
          const before = yield* store.updateSettings({ backgroundLimitPercent })
          expect(yield* store.settings()).toEqual({
            ardenLimitPercent: 90,
            backgroundLimitPercent,
            keepGoingUntil: null,
            automationLimits: {}
          })
          yield* sql`UPDATE chat_runs SET metadata_json = ${paused}`
          yield* sql`CREATE TRIGGER refuse_resume BEFORE UPDATE ON chat_runs BEGIN SELECT RAISE(ABORT, 'resume failed'); END`
          const failed = yield* Effect.exit(store.updateSettings({ backgroundLimitPercent: 75 }))
          expect(Exit.isFailure(failed)).toBe(true)
          expect(yield* store.settings()).toEqual(before)
          expect(yield* sql`SELECT metadata_json FROM chat_runs`).toEqual([
            { metadata_json: paused }
          ])
          yield* sql`DROP TRIGGER refuse_resume`
          const updated = yield* store.updateSettings({ backgroundLimitPercent: 75 })
          expect(updated.backgroundLimitPercent).toBe(75)
          expect(yield* sql`SELECT metadata_json FROM chat_runs`).toEqual([{ metadata_json: "{}" }])
          yield* sql`UPDATE chat_runs SET metadata_json = ${paused}`
          yield* sql`INSERT INTO chat_runs VALUES ('completed', ${paused})`
          const backgroundPause = JSON.stringify({
            quota_pause: { reason: "background_limit", until: "2099-01-01T00:00:00Z" }
          })
          yield* sql`INSERT INTO chat_runs VALUES ('pending', ${backgroundPause})`
          yield* store.recheckPausedRuns()
          yield* store.recheckPausedRuns()
          expect(yield* store.settings()).toEqual(updated)
          expect(
            yield* sql`SELECT status, metadata_json FROM chat_runs ORDER BY status, metadata_json`
          ).toEqual([
            { status: "completed", metadata_json: paused },
            { status: "pending", metadata_json: backgroundPause },
            { status: "pending", metadata_json: "{}" }
          ])
        })
      ).pipe(
        Effect.provide(
          Layer.merge(SqliteClient.layer({ filename: ":memory:" }), PersistenceWriteQueue.layer)
        )
      )
    )
  }
)
