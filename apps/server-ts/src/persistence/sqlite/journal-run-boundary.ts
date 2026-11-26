import { journalRecordsSql } from "@arden-hq/journal/effect"
import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const RUN_BOUNDARY_TYPES = ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "run_cancelled"]

export const journalRunIdSql = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`COALESCE(json_extract(attributes_json, '$.runId'), json_extract(data_json, '$.run_id'))`

export const readLatestRunBoundary = (
  sql: SqlClient.SqlClient,
  sessionId: string
): Statement<{ readonly event_type: unknown; readonly run_id: unknown }> =>
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
