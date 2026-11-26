import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const archiveSpaceChats = (
  sql: SqlClient.SqlClient,
  spaceId: string,
  at: string
): Statement<Row> => sql`
  UPDATE sessions
  SET archived_at = ${at},
    metadata = json_set(COALESCE(metadata, '{}'), '$.archived_with_space', json('true'))
  WHERE space_id = ${spaceId} AND archived_at IS NULL`

export const restoreSpaceChats = (sql: SqlClient.SqlClient, spaceId: string): Statement<Row> => sql`
  UPDATE sessions
  SET archived_at = NULL, metadata = json_remove(metadata, '$.archived_with_space')
  WHERE space_id = ${spaceId} AND archived_at IS NOT NULL
    AND json_extract(metadata, '$.archived_with_space') = 1`
