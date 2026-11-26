import type {
  AutomationContextMode,
  AutomationRun,
  AutomationRunOutput
} from "@arden-hq/protocol/automations"
import {
  AutomationRunSchema,
  AutomationRunSkipSchema,
  AutomationSkipRunWithEventSchema
} from "@arden-hq/protocol/effect/automations"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Row } from "effect/unstable/sql/SqlConnection"
import { inArdenWords } from "../restart-notice.js"
import { shownRunStatus } from "./automation-run-outcome.js"
import { decodeJson, type JsonColumnError } from "./json.js"

export interface AutomationRunRow {
  readonly id: number
  readonly task_id: string
  readonly chat_run_id: string | null
  readonly chat_session_id: string | null
  readonly context_mode: AutomationContextMode
  readonly started_at: string
  readonly ended_at: string | null
  readonly outcome: string | null
  readonly result: string | null
  readonly error: string | null
  readonly skip_json: string | null
}

const chatOf = (row: AutomationRunRow) => {
  if (row.chat_run_id !== null) {
    return { kind: "chat_run", session_id: row.chat_session_id, run_id: row.chat_run_id } as const
  }
  return row.chat_session_id === null
    ? ({ kind: "none" } as const)
    : ({ kind: "chat", session_id: row.chat_session_id } as const)
}

const outputOf = (result: string | null, error: string | null): AutomationRunOutput => {
  if (result === null) return error === null ? { kind: "none" } : { kind: "error", error }
  return error === null ? { kind: "result", result } : { kind: "result_and_error", result, error }
}

export const SkippedWakeSchema = Schema.Struct({
  prompt: Schema.String,
  run_with_event: AutomationSkipRunWithEventSchema
})

export const skipRan = (
  sql: SqlClient.SqlClient,
  skippedRunId: number | undefined,
  taskId: string,
  runId: number
): Effect.Effect<ReadonlyArray<Row>, SqlError> =>
  skippedRunId === undefined
    ? Effect.succeed([])
    : sql`UPDATE automation_runs
  SET skip_json = json_set(skip_json, '$.run_with_event', json_object('kind', 'started',
    'at', json_extract(skip_json, '$.run_with_event.at'), 'run_id', ${runId}))
  WHERE id = ${skippedRunId} AND task_id = ${taskId}
    AND json_extract(skip_json, '$.run_with_event.kind') IN ('queued', 'started')`

export const askedToRun = AutomationSkipRunWithEventSchema.isAnyOf(["queued", "started"])

export const automationRunOfRow = (
  row: AutomationRunRow
): Effect.Effect<AutomationRun, Schema.SchemaError | JsonColumnError> =>
  Effect.gen(function* () {
    const base = {
      id: row.id,
      task_id: row.task_id,
      context_mode: row.context_mode,
      started_at: row.started_at
    }
    const result = inArdenWords(row.result)
    if (row.skip_json !== null) {
      return {
        ...base,
        status: "skipped",
        ended_at: row.ended_at,
        result,
        skip: yield* decodeJson(AutomationRunSkipSchema, row.skip_json)
      }
    }
    const status = yield* shownRunStatus(row.outcome)
    const ran = {
      ...base,
      status,
      chat: chatOf(row),
      output: outputOf(result, inArdenWords(row.error))
    }
    return row.outcome === null ? ran : { ...ran, ended_at: row.ended_at }
  }).pipe(
    Effect.flatMap((run) => Schema.decodeUnknownEffect(AutomationRunSchema)(run)),
    Effect.map((run): AutomationRun => run)
  )
