import type { SqlClient } from "effect/unstable/sql"

export const failureNeedsOwner = (sql: SqlClient.SqlClient) => sql`(
  ending.status = 'failed' AND ending.decided = 1 AND ending.place_kind <> 'parent'
  AND (ending.purpose <> 'chat'
    OR json_extract(chat.metadata_json, '$.run_context.task.item_id') IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM space_task_events AS retry
    WHERE retry.run_ref = ending.run_id AND retry.event_type = 'retry_scheduled'
  )
)`
