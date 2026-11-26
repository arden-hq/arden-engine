import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

/** The owner has Arden open and in front of them at `at`: a desktop client's presence lease
 * (written by `homePresence`) has not run out. */
export const ownerPresentSql = (sql: SqlClient.SqlClient, at: string): Statement<Row> =>
  sql`EXISTS (SELECT 1 FROM home_presence WHERE lease_until > ${at})`
