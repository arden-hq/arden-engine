import type { SqlClient, Statement } from "effect/unstable/sql"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const chatArrivalWaitingSql = (
  sql: SqlClient.SqlClient,
  session: Statement.Fragment
): Statement.Statement<Row> =>
  sql`EXISTS (SELECT 1 FROM automation_deliveries AS arrival WHERE arrival.status = 'pending'
    AND (json_extract(arrival.payload, '$.sessionId') = ${session}
      OR json_extract(arrival.payload, '$.destinationSessionId') = ${session}))`
