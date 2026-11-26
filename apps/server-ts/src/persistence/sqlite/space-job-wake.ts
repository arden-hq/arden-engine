import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { readRunCause, taskWakeDepth } from "./run-cause.js"

import { TASK_WAKER, type TaskWaker, NO_RUN, woken, type WakeCause } from "./space-job-types.js"
import { type SessionLifecycleEventError } from "../sessions/events.js"
import { type SqlError } from "effect/unstable/sql/SqlError"

export interface WakeCauses {
  readonly wakeCause: (
    runId: string | undefined
  ) => Effect.Effect<WakeCause, SessionLifecycleEventError>
  readonly taskWakeCause: (
    itemId: string,
    by: TaskWaker
  ) => Effect.Effect<WakeCause, SqlError | SessionLifecycleEventError>
}

export const makeWakeCauses = (sql: SqlClient.SqlClient): WakeCauses => {
  const wakeCause = Effect.fn("SpaceJobSql.wakeCause")(function* (runId: string | undefined) {
    if (runId === undefined) return NO_RUN
    const cause = yield* readRunCause(sql, runId)
    return woken(cause.produced_by, cause.chain_depth)
  })
  const taskWakeCause = Effect.fn("SpaceJobSql.taskWakeCause")(function* (
    itemId: string,
    by: TaskWaker
  ) {
    switch (by.kind) {
      case TASK_WAKER.run:
        return yield* wakeCause(by.runId)
      case TASK_WAKER.owner:
        return NO_RUN
      case TASK_WAKER.continuation: {
        const [task] = yield* sql<{ readonly chain_depth: number }>`
          SELECT ${taskWakeDepth(sql, sql`${itemId}`)} AS chain_depth`
        return woken(null, task?.chain_depth ?? 0)
      }
    }
  })
  return { wakeCause, taskWakeCause }
}
