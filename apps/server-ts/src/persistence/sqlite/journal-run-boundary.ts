import { journalRecordsSql } from "@arden-hq/journal/effect"
import type { SqlClient } from "effect/unstable/sql"

/** The journal rows that open or close a run. Event admission reads the newest
 * of them, so retention keeps every run's boundary rows. */
export const RUN_BOUNDARY_TYPES = ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "run_cancelled"]

/** The run a journal row belongs to: the `runId` attribute, else the payload's
 * `run_id`. The one expression for it; a row is never matched to a run another way. */
export const journalRunIdSql = (sql: SqlClient.SqlClient) =>
  sql`COALESCE(json_extract(attributes_json, '$.runId'), json_extract(data_json, '$.run_id'))`

/** The newest run-boundary row of a session at or below its checkpoint. */
export const readLatestRunBoundary = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<{ readonly event_type: unknown; readonly run_id: unknown }>`
    SELECT
      event_type,
      ${journalRunIdSql(sql)} AS run_id
    FROM ${journalRecordsSql(sql)}
    WHERE stream_id = ${sessionId}
      AND sequence <= COALESCE((
        SELECT checkpoint_seq
        FROM session_event_checkpoints
        WHERE session_id = ${sessionId}
      ), 0)
      AND event_type IN ${sql.in(RUN_BOUNDARY_TYPES)}
    ORDER BY sequence DESC
    LIMIT 1
  `
