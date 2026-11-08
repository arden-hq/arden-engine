import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  ContextCompactionStoreError,
  type ContextCompactionOperation
} from "../compaction/store.js"
import { sessionBlockingWorkPredicate } from "./session-blocking-work.js"
import { activeRunStatusList, openDeferredCallStatusList } from "./status-sets.js"
import { taskUnfinishedSql } from "./task-status-sql.js"
import { userChatSql } from "./chat-ownership.js"
import { chatArrivalWaitingSql } from "./chat-arrival-waiting.js"

export const assertIdleCompaction = Effect.fn("SqliteContextCompactionStore.assertIdle")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: ContextCompactionOperation
) {
  const rows = yield* sql<{ readonly eligible: number }>`
    SELECT 1 AS eligible FROM sessions AS s
    WHERE s.session_id = ${sessionId} AND s.archived_at IS NULL
      AND ${userChatSql("s")}
      AND NOT (${sessionBlockingWorkPredicate(sql)})
      AND NOT EXISTS (SELECT 1 FROM session_queued_messages WHERE session_id = s.session_id)
      AND NOT EXISTS (SELECT 1 FROM tool_approvals WHERE session_id = s.session_id AND status = 'pending')
      AND NOT EXISTS (SELECT 1 FROM deferred_tool_calls WHERE session_id = s.session_id AND status IN ${openDeferredCallStatusList})
      AND NOT EXISTS (SELECT 1 FROM space_tasks WHERE home_session_id = s.session_id
        AND runs_in = 'chat' AND ${taskUnfinishedSql()})
      AND NOT ${chatArrivalWaitingSql(sql, sql`s.session_id`)}
      AND NOT EXISTS (SELECT 1 FROM sessions AS child JOIN chat_runs AS run ON run.session_id = child.session_id
        WHERE child.parent_session_id = s.session_id AND run.status IN ${activeRunStatusList})
    LIMIT 1
  `.pipe(
    Effect.mapError(
      (cause) =>
        new ContextCompactionStoreError({
          operation,
          reason: "storage",
          sessionId,
          message: "Could not inspect idle compaction admission",
          cause
        })
    )
  )
  if (rows.length === 0)
    return yield* new ContextCompactionStoreError({
      operation,
      reason: "conflict",
      sessionId,
      message: "Idle compaction requires a personal chat without pending work"
    })
})
