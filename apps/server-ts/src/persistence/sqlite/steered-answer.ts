import type { SqlClient } from "effect/unstable/sql"

export const questionAnswerPredicate = (sql: SqlClient.SqlClient) => sql`(
  json_extract(m.message_json, '$.question_answer') IS NOT NULL
)`
