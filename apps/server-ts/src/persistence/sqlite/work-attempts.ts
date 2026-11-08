import { countsAsRun } from "./automation-skip-record.js"
import {
  WorkerAttemptPageOptionsSchema,
  WorkerAttemptPageSchema,
  RunOriginSchema
} from "@arden-hq/protocol/effect/runs"
import type { WorkerAttemptPageOptions } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { decodeJson } from "./json.js"
import { workError } from "./work-records.js"

interface AttemptRow {
  readonly id: number
  readonly run_id: string | null
  readonly session_id: string | null
  readonly origin: string
  readonly item_id: string
  readonly task_generation: number
  readonly status: string
  readonly started_at: string
  readonly ended_at: string | null
  readonly result: string | null
  readonly error: string | null
}

export const makeWorkAttempts = (sql: SqlClient.SqlClient) =>
  Effect.fn("Work.attempts")(function* (itemId: string, input: WorkerAttemptPageOptions) {
    const options = yield* Schema.decodeUnknownEffect(WorkerAttemptPageOptionsSchema)(input).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid attempts page", cause))
    )
    const limit = options.limit ?? 25
    const rows = yield* sql<AttemptRow>`
    SELECT attempt.id, attempt.chat_run_id AS run_id, attempt.chat_session_id AS session_id,
      attempt.origin, attempt.item_id, attempt.task_generation,
      COALESCE(run.status, attempt.status) AS status, attempt.started_at, attempt.ended_at,
      attempt.result, attempt.error
    FROM automation_runs AS attempt
    LEFT JOIN chat_runs AS run ON run.run_id = attempt.chat_run_id
    WHERE attempt.item_id = ${itemId} AND ${countsAsRun(sql, sql`attempt`)}
      AND (${options.cursor ?? null} IS NULL OR attempt.id < ${options.cursor ?? null})
    ORDER BY attempt.id DESC LIMIT ${limit + 1}
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read worker attempts", cause)))
    const visible = rows.slice(0, limit)
    const attempts = yield* Effect.forEach(
      visible,
      Effect.fn(function* (row) {
        const { origin, item_id, task_generation, ...attempt } = row
        return {
          ...attempt,
          context: {
            origin: yield* decodeJson(RunOriginSchema, origin).pipe(
              Effect.mapError((cause) =>
                workError("storage", "Stored attempt origin is corrupt", cause)
              )
            ),
            task: { item_id, generation: task_generation }
          }
        }
      })
    )
    return yield* Schema.decodeUnknownEffect(WorkerAttemptPageSchema)({
      attempts,
      next_cursor: rows.length > limit ? (visible.at(-1)?.id ?? null) : null
    }).pipe(Effect.mapError((cause) => workError("storage", "Stored attempts are corrupt", cause)))
  })
