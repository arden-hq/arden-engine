import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { BROWSER_PROCEDURE_ENQUEUE_SQL } from "../src/persistence/sqlite/browser-procedures.js"
import {
  EVIDENCE_TOOL_CALL_SQL,
  EVIDENCE_URL_SQL
} from "../src/persistence/sqlite/criterion-evidence.js"
import { UPLOAD_NAMED_SQL } from "../src/persistence/sqlite/managed-output-lifecycle.js"
import { ENDED_RUNS_WITH_RUNNING_CALLS_SQL } from "../src/persistence/sqlite/recovery.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"

const boot = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(
        recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
          Layer.provide(PersistenceWriteQueue.layer)
        )
      )
    )
  )

// Boot must ask the short list of unsettled tool calls, never the whole
// tool_calls table: on a real database the full read took 8 to 11 seconds.
it("startup and cleanup queries read their short lists, not whole tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-lost-calls-"))
  try {
    const filename = join(directory, "arden.db")
    await boot(filename)
    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${ENDED_RUNS_WITH_RUNNING_CALLS_SQL}`)
        .all()
        .map((row) => String(row.detail))
      expect(plan.some((step) => step.includes("idx_tool_calls_session_unresolved"))).toBe(true)
      expect(plan.filter((step) => step.startsWith("SCAN"))).toEqual([
        "SCAN call USING INDEX idx_tool_calls_session_unresolved"
      ])
      // The upload check is a lookup in the link table and never reads
      // session_messages: searching message text took 8 to 15 seconds per
      // upload at launch and held up every chat open behind it.
      const uploadPlan = database
        .prepare(`EXPLAIN QUERY PLAN ${UPLOAD_NAMED_SQL}`)
        .all("x", "x")
        .map((row) => String(row.detail))
      expect(uploadPlan.some((step) => step.includes("session_messages"))).toBe(false)
      expect(uploadPlan.some((step) => /SEARCH chat_upload_refs/.test(step))).toBe(true)
      // No test runs these three through the engine's own connection, so the
      // scan check after the test run cannot see them. They are planned here.
      const scansWholeTable = (sql: string, parameters: number): ReadonlyArray<string> =>
        database
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...Array.from({ length: parameters }, () => "x"))
          .map((row) => String(row.detail))
          .filter((step) => /^SCAN (call|run|r|tool_calls|chat_runs)\b/.test(step))
      expect(scansWholeTable(EVIDENCE_TOOL_CALL_SQL, 4)).toEqual([])
      expect(scansWholeTable(EVIDENCE_URL_SQL, 5)).toEqual([])
      expect(scansWholeTable(BROWSER_PROCEDURE_ENQUEUE_SQL, 2)).toEqual([])
      expect(
        database
          .prepare(`EXPLAIN QUERY PLAN ${BROWSER_PROCEDURE_ENQUEUE_SQL}`)
          .all("x", "x")
          .some((row) => /^SCAN c\b/.test(String(row.detail)))
      ).toBe(true)
    } finally {
      database.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
