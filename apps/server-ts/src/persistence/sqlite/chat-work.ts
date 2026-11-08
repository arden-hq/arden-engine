import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatWork, ChatWorkRunKind } from "../runs/queries.js"
import { activeRunStatusList } from "./status-sets.js"
import { userAutomationSql } from "./authority-sql.js"
import { sessionDescendants } from "./tree-walk.js"

export const readChatWork = Effect.fn("ChatWork.read")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const family = sql`WITH RECURSIVE ${sessionDescendants(sql, {
    name: "family",
    from: sql`SELECT ${sessionId} AS session_id
      UNION
      SELECT attempt.chat_session_id FROM automation_runs AS attempt
        JOIN scheduled_tasks AS task ON task.task_id = attempt.task_id
        WHERE task.thread_id = ${sessionId} AND ${userAutomationSql("task")}
          AND attempt.status = 'running' AND attempt.chat_session_id IS NOT NULL`,
    where: sql`child.session_type = 'agent'`
  })}`
  const sessions = yield* sql<{ readonly session_id: string }>`${family}
    SELECT session_id FROM family ORDER BY session_id`
  const runs = yield* sql<{ readonly run_id: string; readonly kind: ChatWorkRunKind }>`${family}
    SELECT run.run_id,
      CASE
        WHEN EXISTS (SELECT 1 FROM automation_runs AS attempt
          JOIN scheduled_tasks AS task ON task.task_id = attempt.task_id
          WHERE attempt.chat_run_id = run.run_id AND task.thread_id = ${sessionId}
            AND ${userAutomationSql("task")})
          THEN 'automation'
        WHEN run.session_id = ${sessionId} THEN 'reply'
        ELSE 'agent'
      END AS kind
    FROM chat_runs AS run
    WHERE run.session_id IN (SELECT session_id FROM family)
      AND run.status IN ${activeRunStatusList}
    ORDER BY run.started_at, run.run_id`
  const workflows = yield* sql<{ readonly script_ref: string }>`${family}
    SELECT script.script_ref FROM code_mode_scripts AS script
      JOIN sessions AS origin ON origin.public_ref = script.origin_session_ref
    WHERE origin.session_id IN (SELECT session_id FROM family) AND script.status = 'running'
    ORDER BY script.script_ref`
  return {
    sessionIds: sessions.map((row) => row.session_id),
    runs: runs.map((row) => ({ runId: row.run_id, kind: row.kind })),
    workflows: workflows.map((row) => row.script_ref)
  } satisfies ChatWork
})
