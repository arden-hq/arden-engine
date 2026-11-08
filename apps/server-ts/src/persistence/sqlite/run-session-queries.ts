import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { EndingRecord } from "../runs/ending.js"
import { RunQueryError, type RunQueries, type SessionRunReference } from "../runs/queries.js"
import type { ChatRunRecord } from "../runs/model.js"
import { activeRunStatusList } from "./status-sets.js"

export const makeSessionRunQueries = (
  sql: SqlClient.SqlClient
): Pick<RunQueries["Service"], "currentForSessions" | "ending" | "sessionId"> => ({
  sessionId: Effect.fn("SqliteRunQueries.sessionId")(function* (runId: string) {
    const rows = yield* sql<{
      readonly session_id: string
    }>`SELECT session_id FROM chat_runs WHERE run_id = ${runId}`.pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            operation: "get",
            message: "Could not resolve the run's session",
            cause
          })
      )
    )
    return rows[0]?.session_id
  }),
  currentForSessions: Effect.fn("SqliteRunQueries.currentForSessions")(function* (
    sessionIds: ReadonlyArray<string>
  ) {
    if (sessionIds.length === 0) return new Map<string, SessionRunReference>()
    const rows = yield* sql<{
      readonly run_id: string
      readonly session_id: string
      readonly status: ChatRunRecord["status"]
      readonly ending_run_id: string | null
      readonly ending_status: EndingRecord["status"] | null
      readonly ending_detail: string | null
      readonly ending_occurred_at: string | null
    }>`WITH ranked AS (
      SELECT run.run_id, run.session_id, run.status, ROW_NUMBER() OVER (
        PARTITION BY session_id ORDER BY
          CASE WHEN status IN ${activeRunStatusList} THEN 0 ELSE 1 END,
          started_at DESC, run_id DESC
      ) AS position FROM chat_runs AS run WHERE session_id IN ${sql.in([...new Set(sessionIds)])}
    )
    SELECT run.run_id, run.session_id, run.status, ending.run_id AS ending_run_id, ending.status AS ending_status,
      ending.detail AS ending_detail, ending.occurred_at AS ending_occurred_at
    FROM ranked AS run
    LEFT JOIN run_endings AS ending ON ending.run_id = (
      SELECT decided.run_id FROM chat_runs AS ended
      JOIN run_endings AS decided ON decided.run_id = ended.run_id AND decided.decided = 1
      WHERE ended.session_id = run.session_id
      ORDER BY ended.started_at DESC, ended.run_id DESC LIMIT 1
    )
    WHERE run.position = 1`.pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            operation: "current_for_sessions",
            message: "Could not load current session runs",
            cause
          })
      )
    )
    const references = rows.map((row) => {
      const current = { runId: row.run_id, status: row.status }
      const latestEnding =
        row.ending_run_id === null || row.ending_status === null || row.ending_occurred_at === null
          ? undefined
          : {
              runId: row.ending_run_id,
              status: row.ending_status,
              detail: row.ending_detail,
              occurredAt: row.ending_occurred_at
            }
      return [row.session_id, { current, latestEnding }] as const
    })
    return new Map(references)
  }),
  ending: Effect.fn("SqliteRunQueries.ending")(function* (runId: string) {
    const rows = yield* sql<{
      readonly run_id: string
      readonly purpose: EndingRecord["purpose"]
      readonly status: EndingRecord["status"]
      readonly detail: string | null
      readonly text: string
      readonly place: string | null
      readonly place_kind: EndingRecord["placeKind"]
      readonly occurred_at: string
      readonly shown: number
    }>`SELECT run_id, purpose, status, detail, text, place, place_kind, occurred_at, shown
      FROM run_endings WHERE run_id = ${runId} AND decided = 1`.pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            operation: "ending",
            message: "Could not load the decided ending",
            cause
          })
      )
    )
    const row = rows[0]
    return row === undefined
      ? undefined
      : {
          runId: row.run_id,
          purpose: row.purpose,
          status: row.status,
          detail: row.detail,
          text: row.text,
          place: row.place,
          placeKind: row.place_kind,
          occurredAt: row.occurred_at,
          shown: row.shown === 1,
          decided: true
        }
  })
})
