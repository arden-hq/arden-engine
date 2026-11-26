import { Effect, Schema } from "effect"
import {
  automationIdEffect,
  skipCorrupt,
  storeError,
  type AutomationStoreDeps
} from "./automation-rows.js"
import type { AutomationRun } from "@arden-hq/protocol/automations"
import type { AutomationStoreError } from "../automations/store.js"
import { outcomeSql } from "./automation-run-outcome.js"
import { automationRunOfRow, type AutomationRunRow } from "./automation-run-rows.js"
import { makeAutomationRowReads } from "./automation-row-reads.js"

export interface AutomationRunHistory {
  readonly runs: (
    automationId: string,
    limit: number
  ) => Effect.Effect<ReadonlyArray<AutomationRun> | null, AutomationStoreError>
}

export const makeAutomationRunHistory = ({
  writer,
  rules
}: Pick<AutomationStoreDeps, "writer" | "rules">): AutomationRunHistory => {
  const sql = writer.sql
  const { findAutomationRow } = makeAutomationRowReads({ writer, rules })
  const runs = Effect.fn("SqliteAutomationStore.runs")(function* (
    automationId: string,
    limit: number
  ) {
    const validAutomationId = yield* automationIdEffect(automationId, "runs")
    const validLimit = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
    )(limit).pipe(
      Effect.mapError((cause) =>
        storeError(
          "runs",
          "invalid",
          "Automation run limit must be between 1 and 200",
          validAutomationId,
          cause
        )
      )
    )
    if ((yield* findAutomationRow(validAutomationId, "runs")) === null) return null
    const rows = yield* sql<AutomationRunRow>`
      SELECT run.id, run.task_id, run.chat_run_id, run.chat_session_id, run.context_mode,
             run.started_at, run.ended_at, ${outcomeSql(sql, sql`run`)} AS outcome,
             run.result, run.error,
             CASE WHEN json_extract(run.skip_json, '$.reason') = 'prefilter'
               THEN run.skip_json END AS skip_json
      FROM automation_runs AS run
      WHERE run.task_id = ${validAutomationId}
      ORDER BY run.id DESC
      LIMIT ${validLimit}
    `.pipe(
      Effect.mapError((cause) =>
        storeError("runs", "storage", "Could not list Automation runs", validAutomationId, cause)
      )
    )
    return yield* skipCorrupt({
      rows,
      decode: (row) =>
        automationRunOfRow(row).pipe(
          Effect.mapError((cause) =>
            storeError(
              "runs",
              "corrupt",
              "Stored Automation run is corrupt",
              validAutomationId,
              cause
            )
          )
        ),
      skipped: (row) => ({ automation_id: validAutomationId, run_id: row.id }),
      what: "an Automation run"
    })
  })

  return { runs }
}
