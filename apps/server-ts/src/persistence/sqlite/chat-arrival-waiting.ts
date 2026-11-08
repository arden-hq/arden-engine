import type { SqlClient, Statement } from "effect/unstable/sql"

export const chatArrivalWaitingSql = (sql: SqlClient.SqlClient, session: Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM automation_deliveries AS arrival WHERE arrival.status = 'pending'
    AND (json_extract(arrival.payload, '$.sessionId') = ${session}
      OR json_extract(arrival.payload, '$.destinationSessionId') = ${session}))`
