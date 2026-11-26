import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { UnitOfWork } from "../unit-of-work.js"
import type { WorkStoreError } from "../work/store.js"
import type { SpaceJobSql } from "./space-job-types.js"
import type { WorkEvents } from "./work-events.js"
import type { WorkItemRow } from "./work-items.js"
import { workError } from "./work-records.js"

const BLOCK_STRIKE_LIMIT = 3

export interface TaskBlockLoop {
  readonly strike: (itemId: string, reason: string) => Effect.Effect<boolean, WorkStoreError>
  readonly forget: (itemId: string) => Effect.Effect<void, WorkStoreError>
  readonly breakLoop: (
    spaceId: string | null,
    itemId: string,
    reason: string,
    at: string
  ) => Effect.Effect<void, WorkStoreError, UnitOfWork>
}

export const makeTaskBlockLoop = ({
  sql,
  taskEvent,
  spaceJobs
}: {
  readonly sql: SqlClient.SqlClient
  readonly taskEvent: WorkEvents["taskEvent"]
  readonly spaceJobs: SpaceJobSql
}): TaskBlockLoop => {
  const strike = Effect.fn("SqliteWorkStore.rememberBlock")(function* (
    itemId: string,
    reason: string
  ): Effect.fn.Return<boolean, WorkStoreError> {
    const rows = yield* sql<Pick<WorkItemRow, "block_count">>`
      UPDATE space_tasks
      SET block_count = CASE WHEN last_block_reason IS ${reason} THEN block_count + 1 ELSE 1 END,
          last_block_reason = ${reason}
      WHERE item_id = ${itemId}
      RETURNING block_count
    `.pipe(
      Effect.mapError((cause) =>
        workError("storage", "Could not record the Space task block", cause)
      )
    )
    const row = rows[0]
    if (row === undefined) return yield* workError("not_found", "Space task not found")
    return row.block_count >= BLOCK_STRIKE_LIMIT
  })

  const forget = (itemId: string): Effect.Effect<void, WorkStoreError> =>
    sql`
    UPDATE space_tasks
    SET block_count = 0, last_block_reason = NULL
    WHERE item_id = ${itemId}
  `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        workError("storage", "Could not clear the Space task blocks", cause)
      )
    )

  const breakLoop = Effect.fn("SqliteWorkStore.breakBlockLoop")(function* (
    spaceId: string | null,
    itemId: string,
    reason: string,
    at: string
  ): Effect.fn.Return<void, WorkStoreError, UnitOfWork> {
    yield* taskEvent(spaceId, itemId, "block_loop", reason, at)
    return yield* spaceJobs
      .stopTask(itemId)
      .pipe(
        Effect.mapError((cause) => workError("storage", "Could not stop the Space task job", cause))
      )
  })

  return { strike, forget, breakLoop }
}
