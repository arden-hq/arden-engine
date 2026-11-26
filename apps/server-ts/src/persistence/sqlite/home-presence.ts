import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const ownerPresentSql = (sql: SqlClient.SqlClient, at: string): Statement<Row> =>
  sql`EXISTS (SELECT 1 FROM home_presence WHERE lease_until > ${at})`
