import { type TaskRecord, type WorkPageRecord } from "../work/task-record.js"
import { WorkTaskKeySchema } from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SpaceWorkPageOptions } from "@arden-hq/protocol/spaces/work"
import {
  itemPage,
  TASK_ADDRESS,
  TASK_SCOPE,
  type TaskAddress,
  type TaskScope,
  type WorkStoreError
} from "../work/store.js"
import { workError } from "./work-records.js"

export const taskScopeSql = (sql: SqlClient.SqlClient, scope: TaskScope): Statement.Fragment => {
  switch (scope.kind) {
    case TASK_SCOPE.space:
      return sql`item.space_id = ${scope.spaceId}`
    case TASK_SCOPE.chat:
      return sql`item.space_id IS NULL AND item.home_session_id = ${scope.sessionId}`
    case TASK_SCOPE.none:
      return sql`item.space_id IS NULL AND item.home_session_id IS NULL`
  }
}

export const resolveTaskItem = Effect.fn("Work.resolveTaskItem")(function* (
  sql: SqlClient.SqlClient,
  address: TaskAddress
) {
  const match =
    address.kind === TASK_ADDRESS.item
      ? sql`item.item_id = ${address.itemId}`
      : sql`item.stable_key = ${yield* Schema.decodeUnknownEffect(WorkTaskKeySchema)(
          address.key
        ).pipe(
          Effect.mapError((cause) => workError("invalid", "Work task key is invalid", cause))
        )} AND ${taskScopeSql(sql, address.scope)}`
  const rows = yield* sql<{ readonly item_id: string }>`
    SELECT item.item_id FROM space_tasks AS item
    LEFT JOIN spaces AS space ON space.space_id = item.space_id
    WHERE ${match}
      AND (item.space_id IS NULL OR space.archived_at IS NULL)
    LIMIT 1
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not find the Task", cause)))
  const row = rows[0]
  if (row === undefined) return yield* workError("not_found", "Task not found")
  return row.item_id
})

export const taskSpaceActiveSql = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql`(space_tasks.space_id IS NULL OR EXISTS (
    SELECT 1 FROM spaces AS space
    WHERE space.space_id = space_tasks.space_id AND space.archived_at IS NULL
  ))`

export const readTask = (
  sql: SqlClient.SqlClient,
  page: (options: SpaceWorkPageOptions) => Effect.Effect<WorkPageRecord, WorkStoreError>,
  address: TaskAddress
): Effect.Effect<TaskRecord, WorkStoreError> =>
  resolveTaskItem(sql, address).pipe(
    Effect.flatMap((itemId) => page(itemPage(itemId))),
    Effect.flatMap((found) => {
      const task = found.items[0]
      return task === undefined
        ? Effect.fail(workError("not_found", "Task not found"))
        : Effect.succeed(task)
    })
  )
