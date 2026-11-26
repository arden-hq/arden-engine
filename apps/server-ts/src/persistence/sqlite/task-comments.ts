import { decodeCreateSpaceTaskCommentInputEffect } from "@arden-hq/protocol/effect/spaces/work"
import {
  SPACE_TASK_CREATED_BY,
  type CreateSpaceTaskCommentInput,
  type SpaceTaskActor
} from "@arden-hq/protocol/spaces/work"
import { DateTime, Effect } from "effect"
import { TaskDirectionChanged } from "../work/task-direction.js"
import type { TaskCommentRecord } from "../work/task-record.js"
import { WorkStore, WorkStoreError, type TaskAddress } from "../work/store.js"
import type { PersistenceDeps } from "./deps.js"
import { assertRunTaskAuthority } from "./run-task-authority.js"
import { resolveTaskItem } from "./task-address.js"
import { assertCallPlan } from "./task-direction.js"
import type { JobTarget } from "./work-job-target.js"
import type { WorkItemRow } from "./work-items.js"
import { decodeWorkComment, workError, type WorkCommentRow } from "./work-records.js"

export const makeTaskComments = ({
  writer,
  jobTarget
}: Pick<PersistenceDeps, "writer"> & { readonly jobTarget: JobTarget }): Pick<
  WorkStore["Service"],
  "comment" | "commentFromJob"
> => {
  const sql = writer.sql
  const commentFor = Effect.fn("SqliteWorkStore.commentFor")(function* (
    address: TaskAddress,
    input: CreateSpaceTaskCommentInput,
    actor: SpaceTaskActor,
    runId?: string,
    toolCallId?: string
  ): Effect.fn.Return<TaskCommentRecord, WorkStoreError | TaskDirectionChanged> {
    const valid = yield* decodeCreateSpaceTaskCommentInputEffect(input).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid Space task comment", cause))
    )
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const itemId = yield* resolveTaskItem(sql, address)
          const tasks = yield* sql<Pick<WorkItemRow, "item_id" | "space_id">>`
          SELECT item_id, space_id FROM space_tasks WHERE item_id = ${itemId}
        `
          const task = tasks[0]
          if (task === undefined) return yield* workError("not_found", "Space task not found")
          if (runId) yield* assertRunTaskAuthority(sql, runId, task.item_id)
          if (runId && toolCallId) yield* assertCallPlan(sql, { runId, toolCallId })
          const rows = yield* sql<WorkCommentRow>`
          INSERT INTO space_task_comments (space_id, item_id, author, body, created_at, kind)
          VALUES (${task.space_id}, ${task.item_id}, ${actor}, ${valid.body}, ${now}, 'note')
          RETURNING comment_id, space_id, item_id, author, body, created_at, kind
        `
          const row = rows[0]
          if (row === undefined)
            return yield* workError("storage", "Space task comment insert returned no row")
          return yield* decodeWorkComment(row)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError || cause instanceof TaskDirectionChanged
            ? cause
            : workError("storage", "Could not create Space task comment", cause)
        )
      )
  })

  const comment: WorkStore["Service"]["comment"] = (address, input, runId, toolCallId) =>
    commentFor(
      address,
      input,
      runId ? SPACE_TASK_CREATED_BY.worker : SPACE_TASK_CREATED_BY.user,
      runId,
      toolCallId
    )

  const commentFromJob = Effect.fn("SqliteWorkStore.commentFromJob")(function* (
    originAutomationId: string,
    key: string,
    input: CreateSpaceTaskCommentInput,
    requestedSpaceId?: string,
    runId?: string,
    toolCallId?: string
  ): Effect.fn.Return<TaskCommentRecord, WorkStoreError | TaskDirectionChanged> {
    const target = yield* jobTarget(originAutomationId, key, requestedSpaceId)
    return yield* commentFor(target, input, SPACE_TASK_CREATED_BY.worker, runId, toolCallId)
  })

  return { comment, commentFromJob }
}
