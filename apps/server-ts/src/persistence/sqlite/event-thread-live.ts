import type { SqlClient, Statement } from "effect/unstable/sql"
import type { Row } from "effect/unstable/sql/SqlConnection"

const pendingPostDeliverySql = (sql: SqlClient.SqlClient, deliveryId: Statement.Fragment) =>
  sql`EXISTS (
    SELECT 1 FROM automation_deliveries AS earlier
    WHERE earlier.delivery_id = ${deliveryId} AND earlier.status = 'pending')`

export const eventThreadLiveSql = (
  sql: SqlClient.SqlClient,
  mapped: string
): Statement.Statement<Row> => sql`(
    EXISTS (SELECT 1 FROM sessions AS chat
      WHERE chat.session_id = ${sql(mapped)}.session_id
        AND chat.archived_at IS NULL AND chat.space_id IS NOT NULL)
    AND (EXISTS (SELECT 1 FROM session_messages AS message
          WHERE message.session_id = ${sql(mapped)}.session_id
            AND message.message_id = ${sql(mapped)}.message_id)
      OR ${pendingPostDeliverySql(sql, sql`${sql(mapped)}.delivery_id`)}))`
