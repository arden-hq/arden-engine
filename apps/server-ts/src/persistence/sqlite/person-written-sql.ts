import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { SqlClient, Statement } from "effect/unstable/sql"

export const writtenByPersonSql = (
  sql: SqlClient.SqlClient,
  messageJson: Statement.Fragment
): Statement.Fragment =>
  sql`(json_extract(${messageJson}, '$.role') = ${ROLE.user}
    AND json_type(${messageJson}, '$.question_answer') IS NULL)`

export const chatActivitySql = (
  sql: SqlClient.SqlClient,
  messageJson: Statement.Fragment
): Statement.Fragment =>
  sql`(${writtenByPersonSql(sql, messageJson)}
    OR (json_extract(${messageJson}, '$.role') = ${ROLE.interaction}
      AND json_extract(${messageJson}, '$.from.source') = 'automation')
    OR json_extract(${messageJson}, '$.role') = ${ROLE.assistant})`
