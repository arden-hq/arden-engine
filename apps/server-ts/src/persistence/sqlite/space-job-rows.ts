import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { taskHasHold } from "./task-hold-state.js"
import { taskConversationSql } from "./task-conversation.js"

export interface SpaceRow {
  readonly space_id: string
  readonly name: string
  readonly instructions: string | null
  readonly page_id: string | null
  readonly page_path: string | null
  readonly inference_enabled: number
  readonly archived_at: string | null
}

export interface TaskRow {
  readonly item_id: string
  readonly space_id: string | null
  readonly home_session_id: string | null
  readonly speaks_in_space_chat: number
  readonly runs_in: "chat" | "background"
  readonly stable_key: string
  readonly text: string
  readonly body: string | null
  readonly continuation_context: string | null
  readonly block_reason: string | null
  readonly status: string
  readonly owner: string
  readonly blocked: number
  readonly held: number
  readonly waiting_on: string | null
  readonly due_at: string | null
  readonly next_attempt_at: string | null
  readonly updated_at: string
  readonly space_name: string | null
  readonly space_instructions: string | null
  readonly page_id: string | null
  readonly page_path: string | null
  readonly space_archived_at: string | null
}

export const readJobSpace = Effect.fn("SpaceJobSql.space")(function* (
  sql: SqlClient.SqlClient,
  spaceId: string
) {
  const rows = yield* sql<SpaceRow>`
    SELECT space_id, name, instructions, page_id, page_path,
           json_extract(inference_policy, '$.enabled') AS inference_enabled,
           archived_at
    FROM spaces
    WHERE space_id = ${spaceId}
    LIMIT 1
  `
  return rows[0] ?? null
})

export const readJobTask = Effect.fn("SpaceJobSql.taskByItemId")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const rows = yield* sql<TaskRow>`
    SELECT item.item_id, item.space_id, item.home_session_id, item.runs_in, item.stable_key,
           ${taskConversationSql(sql, sql`item.item_id`)} IS (SELECT conversation.session_id
             FROM space_conversations AS conversation WHERE conversation.space_id = item.space_id)
             AS speaks_in_space_chat,
           item.text, item.body, item.continuation_context,
           (SELECT event.summary FROM space_task_events AS event
            WHERE event.item_id = item.item_id AND event.event_type = 'blocked'
            ORDER BY event.event_id DESC LIMIT 1) AS block_reason,
           item.status, item.owner, item.blocked, item.waiting_on, item.due_at,
           item.next_attempt_at, item.updated_at, ${taskHasHold(sql, sql`item`)} AS held,
           space.name AS space_name, space.instructions AS space_instructions,
           space.page_id, space.page_path,
           space.archived_at AS space_archived_at
    FROM space_tasks AS item
    LEFT JOIN spaces AS space ON space.space_id = item.space_id
    WHERE item.item_id = ${itemId}
    LIMIT 1
  `
  return rows[0] ?? null
})
