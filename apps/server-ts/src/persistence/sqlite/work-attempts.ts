import { RunOriginSchema, wireRunContext } from "../runs/stored-context.js"
import { countsAsRun } from "./automation-skip-record.js"
import {
  WorkerAttemptPageOptionsSchema,
  WorkerAttemptPageSchema
} from "@arden-hq/protocol/effect/runs"
import {
  ATTEMPT_END,
  ATTEMPT_RUN,
  ATTEMPT_TEXT,
  RUN_PAGE,
  RUN_PAGE_NEXT,
  type RunPageNext,
  type WorkerAttemptPageOptions
} from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { decodeJson } from "./json.js"
import { workError } from "./work-records.js"
import type { WorkStore } from "../work/store.js"

const attemptText = (text: string | null) =>
  text === null ? { kind: ATTEMPT_TEXT.none } : { kind: ATTEMPT_TEXT.text, text }

const nextAttemptPage = (lastId: number | undefined): RunPageNext<number> =>
  lastId === undefined ? { kind: RUN_PAGE_NEXT.end } : { kind: RUN_PAGE_NEXT.more, cursor: lastId }

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

export const makeWorkAttempts = (sql: SqlClient.SqlClient): WorkStore["Service"]["attempts"] =>
  Effect.fn("Work.attempts")(function* (itemId: string, input: WorkerAttemptPageOptions) {
    const options = yield* Schema.decodeUnknownEffect(WorkerAttemptPageOptionsSchema)(input).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid attempts page", cause))
    )
    const limit = options.limit
    const before = options.page.kind === RUN_PAGE.after ? options.page.cursor : null
    const rows = yield* sql<AttemptRow>`
    SELECT attempt.id, attempt.chat_run_id AS run_id, attempt.chat_session_id AS session_id,
      attempt.origin, attempt.item_id, attempt.task_generation,
      COALESCE(run.status, attempt.status) AS status, attempt.started_at, attempt.ended_at,
      attempt.result, attempt.error
    FROM automation_runs AS attempt
    LEFT JOIN chat_runs AS run ON run.run_id = attempt.chat_run_id
    WHERE attempt.item_id = ${itemId} AND ${countsAsRun(sql, sql`attempt`)}
      AND (${before} IS NULL OR attempt.id < ${before})
    ORDER BY attempt.id DESC LIMIT ${limit + 1}
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read worker attempts", cause)))
    const visible = rows.slice(0, limit)
    const attempts = yield* Effect.forEach(
      visible,
      Effect.fn(function* (row) {
        const { origin, item_id, task_generation } = row
        return {
          id: row.id,
          run:
            row.run_id === null || row.session_id === null
              ? { kind: ATTEMPT_RUN.none }
              : { kind: ATTEMPT_RUN.run, run_id: row.run_id, session_id: row.session_id },
          status: row.status,
          started_at: row.started_at,
          end:
            row.ended_at === null
              ? { kind: ATTEMPT_END.open }
              : { kind: ATTEMPT_END.ended, at: row.ended_at },
          result: attemptText(row.result),
          error: attemptText(row.error),
          context: wireRunContext({
            origin: yield* decodeJson(RunOriginSchema, origin).pipe(
              Effect.mapError((cause) =>
                workError("storage", "Stored attempt origin is corrupt", cause)
              )
            ),
            task: { item_id, generation: task_generation }
          })
        }
      })
    )
    return yield* Schema.decodeUnknownEffect(WorkerAttemptPageSchema)({
      attempts,
      next: nextAttemptPage(rows.length > limit ? visible.at(-1)?.id : undefined)
    }).pipe(Effect.mapError((cause) => workError("storage", "Stored attempts are corrupt", cause)))
  })
