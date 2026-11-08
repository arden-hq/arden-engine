import {
  activeRunStatusList,
  liveToolStatusList,
  openDeferredCallStatusList,
  unresolvedToolStatusList
} from "./status-sets.js"
import { countsAsRun } from "./automation-skip-record.js"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { taskUnfinishedSql } from "./task-status-sql.js"
import { sessionAncestors } from "./tree-walk.js"

const hasRetainedWork = (sql: SqlClient.SqlClient, sessionId: Statement.Fragment) => sql`(
  EXISTS (
    -- Retention is conservative: an unresolved descendant keeps its owner even
    -- when old delegation evidence cannot authorize a visible decision card.
    WITH RECURSIVE ${sessionAncestors(sql, {
      name: "work_owners",
      from: sql`SELECT session_id FROM chat_runs WHERE status IN ${activeRunStatusList}
        UNION
        SELECT session_id FROM tool_approvals WHERE status = 'pending'
        UNION
        SELECT session_id FROM deferred_tool_calls WHERE status IN ${openDeferredCallStatusList}
        UNION
        SELECT session_id FROM tool_calls WHERE status IN ${unresolvedToolStatusList}
          AND (status IN ${liveToolStatusList} OR (status = 'uncertain' AND changes_state = 1))`,
      where: sql`child.session_type = 'agent'`
    })}
    SELECT 1 FROM work_owners WHERE session_id = ${sessionId}
  )
  -- The sessions an unfinished Task names: its home, its chat sources and the
  -- chats of its counted attempts. One set per statement, not a scan per row.
  OR ${sessionId} IN (
    -- Materialized, and CROSS JOIN keeps the order: the few unfinished Tasks
    -- drive the attempts through idx_automation_runs_item, never a scan of every run.
    WITH retained_task AS MATERIALIZED (
      SELECT task.item_id, task.home_session_id FROM space_tasks AS task
      WHERE ${taskUnfinishedSql("task")}
    ), retained_attempt AS MATERIALIZED (
      SELECT attempt.chat_session_id, attempt.origin
      FROM retained_task CROSS JOIN automation_runs AS attempt ON attempt.item_id = retained_task.item_id
      WHERE ${countsAsRun(sql, sql`attempt`)}
    )
    SELECT named.session_id FROM (
      SELECT home_session_id AS session_id FROM retained_task
      UNION ALL SELECT json_extract(source.source, '$.session_id')
        FROM retained_task JOIN space_task_sources AS source ON source.item_id = retained_task.item_id
        WHERE json_extract(source.source, '$.kind') = 'chat'
      UNION ALL SELECT chat_session_id FROM retained_attempt
      UNION ALL SELECT json_extract(origin, '$.session_id') FROM retained_attempt
    ) AS named
    -- A NULL in the set would make IN answer NULL, not false.
    WHERE named.session_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM run_questions AS question JOIN chat_runs AS run ON run.run_id = question.run_id
    LEFT JOIN space_tasks AS task ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
    WHERE question.resolution IS NULL AND question.closed_at IS NULL
      AND (run.session_id = ${sessionId} OR json_extract(run.metadata_json, '$.run_context.origin.session_id') = ${sessionId})
      AND (json_extract(run.metadata_json, '$.run_context.task') IS NULL
        OR ${taskUnfinishedSql("task")}))
  OR EXISTS (SELECT 1 FROM automation_deliveries AS delivery
    WHERE delivery.status = 'pending' AND (
      json_extract(delivery.payload, '$.sessionId') = ${sessionId}
      OR EXISTS (SELECT 1 FROM json_each(delivery.payload, '$.runIds') AS member
        JOIN chat_runs AS run ON run.run_id = member.value WHERE run.session_id = ${sessionId})))
  OR EXISTS (SELECT 1 FROM home_letter AS letter JOIN chat_runs AS run ON run.run_id = letter.run_id
    WHERE run.session_id = ${sessionId})
  OR EXISTS (SELECT 1 FROM home_letter AS letter, json_each(letter.sources_json) AS source
    WHERE json_extract(source.value, '$.session_id') = ${sessionId}
      OR json_extract(source.value, '$.question.session_id') = ${sessionId}
      OR EXISTS (SELECT 1 FROM chat_runs AS run WHERE run.session_id = ${sessionId}
        AND run.run_id = json_extract(source.value, '$.run_ref')))
)`

export const sessionActiveWorkSql = (sql: SqlClient.SqlClient, alias: string) => {
  const session = sql.literal(alias)
  return sql`(EXISTS (
        SELECT 1 FROM code_mode_scripts AS script
        WHERE script.origin_session_ref = ${session}.public_ref
          AND script.status = 'running'
      ) OR ${hasRetainedWork(sql, sql`${session}.session_id`)}
      OR EXISTS (SELECT 1 FROM chat_runs AS run
        WHERE run.session_id = ${session}.session_id
          AND run.status IN ${activeRunStatusList})
      OR EXISTS (SELECT 1 FROM tool_calls AS tool_call
        WHERE tool_call.session_id = ${session}.session_id
          -- Implied by the next line; it lets idx_tool_calls_session_unresolved serve it.
          AND tool_call.status IN ${unresolvedToolStatusList}
          AND (tool_call.status IN ${liveToolStatusList}
            OR (tool_call.status = 'uncertain' AND tool_call.changes_state = 1))))`
}
