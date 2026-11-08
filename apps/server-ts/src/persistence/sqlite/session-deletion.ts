import { deleteStreamInTransaction } from "@arden-hq/journal/effect"
import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { uploadIdsIn } from "../sessions/chat-uploads.js"
import { SESSION_OWNED_TABLES } from "../sessions/ownership.js"
import { deleteRunSidecarsBySessionInTransaction } from "./run-sidecar-mutations.js"
import { haltAutomation } from "./automation-halt.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"

export const deleteSessionOwnedData = Effect.fn("SqliteSession.deleteOwnedData")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  sessionId: string
) {
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`INSERT INTO session_file_cleanup (session_id, queued_at)
    VALUES (${sessionId}, ${now})
    ON CONFLICT(session_id) DO NOTHING`
  const attaching = yield* sql<{ readonly message_json: string }>`SELECT message_json
    FROM session_messages
    WHERE session_id = ${sessionId} AND role = 'user' AND instr(message_json, '/uploads/') > 0`
  for (const uploadId of uploadIdsIn(attaching.map((row) => row.message_json).join("\n"))) {
    yield* sql`INSERT INTO chat_upload_cleanup (upload_id, queued_at)
      VALUES (${uploadId}, ${now})
      ON CONFLICT(upload_id) DO NOTHING`
  }
  yield* deleteRunSidecarsBySessionInTransaction(sql, sessionId)
  const endedJobs = yield* sql<{ readonly task_id: string }>`SELECT task_id FROM scheduled_tasks
    WHERE purpose = 'task_execution' AND owner_task_id IN (SELECT item_id FROM space_tasks
      WHERE home_session_id = ${sessionId} AND space_id IS NULL)`
  for (const job of endedJobs)
    yield* haltAutomation({ sql, sessionEvents, automationId: job.task_id, halt: "stop" })
  yield* sql`DELETE FROM space_tasks WHERE home_session_id = ${sessionId} AND space_id IS NULL`
  yield* sql`UPDATE space_tasks SET home_session_id = NULL, runs_in = 'background'
    WHERE home_session_id = ${sessionId}`
  for (const table of SESSION_OWNED_TABLES) {
    if (table === "chat_runs") {
      yield* sql`DELETE FROM chat_runs WHERE session_id = ${sessionId}
        AND NOT EXISTS (SELECT 1 FROM run_questions WHERE run_questions.run_id = chat_runs.run_id)
        AND NOT EXISTS (SELECT 1 FROM automation_runs WHERE automation_runs.chat_run_id = chat_runs.run_id)
        AND run_id NOT IN (SELECT parent_run_id FROM sessions WHERE parent_run_id IS NOT NULL)
        AND run_id NOT IN (SELECT member.value FROM automation_deliveries AS delivery, json_each(delivery.payload, '$.runIds') AS member
          WHERE member.value IS NOT NULL)`
    } else {
      yield* sql.unsafe(`DELETE FROM "${table}" WHERE session_id = ?`, [sessionId])
    }
  }
  yield* sql`UPDATE permission_rules
    SET source_question_id = NULL, source_run_id = NULL, source_tool_call_id = NULL
    WHERE rule_id IN (SELECT permission_id FROM permission_changes
      WHERE permission_kind = 'rule' AND source_session_id = ${sessionId})`
  yield* sql`DELETE FROM question_decisions WHERE session_id = ${sessionId}`
  yield* sql`DELETE FROM tool_approval_decisions WHERE session_id = ${sessionId}`
  yield* sql`DELETE FROM permission_changes
    WHERE source_session_id = ${sessionId} OR principal = ${`chat:${sessionId}`}`
  yield* sql`UPDATE chat_runs SET last_seq = NULL, client_id = NULL,
    metadata_json = json_set(metadata_json, '$.trace_removed_at',
      COALESCE(json_extract(metadata_json, '$.trace_removed_at'), ${now}))
    WHERE session_id = ${sessionId}`
  yield* sql`UPDATE automation_deliveries SET payload = json_set(payload, '$.destinationDeletedAt',
      COALESCE(json_extract(payload, '$.destinationDeletedAt'), ${now}))
    WHERE json_extract(payload, '$.sessionId') = ${sessionId}`
  yield* deleteStreamInTransaction(sql, sessionId)
})
