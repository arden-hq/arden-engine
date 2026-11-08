import { Effect } from "effect"
import type { PersistenceDeps } from "./deps.js"
import {
  SessionTurnQueries,
  SessionTurnQueryError,
  type SessionTurnShell
} from "../turns/queries.js"
import { failedRunStatusList, restartCutRunSql } from "./status-sets.js"
import { inArdenWords } from "../restart-notice.js"

interface TurnShellRow {
  readonly turn_id: string
  readonly message_start_seq: number
  readonly message_end_seq: number
  readonly started_at: string
  readonly ended_at: string
  readonly error_code: string | null
  readonly error_message: string | null
}

export const makeSessionTurnQueries = ({
  reader
}: Pick<PersistenceDeps, "reader">): SessionTurnQueries["Service"] => {
  const sql = reader
  const shellsFor = Effect.fn("SessionTurnQueries.shellsFor")(function* (
    sessionId: string,
    turnIds: ReadonlyArray<string>
  ): Effect.fn.Return<ReadonlyArray<SessionTurnShell>, SessionTurnQueryError> {
    if (turnIds.length === 0) return []
    const rows = yield* sql<TurnShellRow>`
      WITH last_run AS (
        SELECT json_extract(metadata_json, '$.turn_id') AS turn_id,
               status, stop_reason, error_code, error_message,
               ROW_NUMBER() OVER (
                 PARTITION BY json_extract(metadata_json, '$.turn_id')
                 ORDER BY started_at DESC, run_id DESC
               ) AS recency
        FROM chat_runs
        WHERE session_id = ${sessionId}
          AND json_extract(metadata_json, '$.turn_id') IN ${sql.in(turnIds)}
      )
      SELECT turn.turn_id, turn.message_start_seq, turn.message_end_seq,
             turn.started_at, turn.ended_at,
             last_run.error_code, last_run.error_message
      FROM session_turns AS turn
      LEFT JOIN last_run
        ON last_run.turn_id = turn.turn_id
       AND last_run.recency = 1
       AND last_run.status IN ${failedRunStatusList}
       AND NOT ${restartCutRunSql("last_run")}
       AND last_run.error_code IS NOT NULL
       AND last_run.error_message IS NOT NULL
      WHERE turn.session_id = ${sessionId} AND turn.turn_id IN ${sql.in(turnIds)}
      ORDER BY turn.turn_index
    `.pipe(
      Effect.mapError(
        (cause) =>
          new SessionTurnQueryError({
            sessionId,
            message: "Could not load session turn shells",
            cause
          })
      )
    )
    return rows.map((row) => ({
      turnId: row.turn_id,
      messageStartSeq: row.message_start_seq,
      messageEndSeq: row.message_end_seq,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      failure:
        row.error_code === null || row.error_message === null
          ? undefined
          : { code: row.error_code, message: inArdenWords(row.error_message) }
    }))
  })

  return SessionTurnQueries.of({ shellsFor })
}
