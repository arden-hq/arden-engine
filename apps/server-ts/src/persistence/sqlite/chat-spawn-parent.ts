import { STORED_RUN_STATUS } from "./status-sets.js"
import { Effect } from "effect"
import { writeError } from "./chat-write-errors.js"
import { runAutomationContextMode, runAutomationOrigin } from "./chat-run.js"
import { detachedWorkflowCalls } from "./detached-workflow-calls.js"
import { spawnAgentInputSchema } from "./chat-agent-spawn-input.js"
import type { PersistenceDeps } from "./deps.js"
import { type SpawnParentRow, spawnError } from "./chat-agent-spawn-rows.js"

export const loadSpawnParent = Effect.fn("SqliteChatWriteStore.loadSpawnParent")(function* (
  sql: PersistenceDeps["writer"]["sql"],
  valid: typeof spawnAgentInputSchema.Type
) {
  const parentRows = yield* sql<SpawnParentRow>`
        SELECT run.run_id, run.session_id, run.status, run.client_id,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               run.assistant_message_id, run.model_id, run.reasoning_effort,
               run.last_seq,
               json_extract(run.metadata_json, '$.automation.task_id') AS automation_task_id,
               json_extract(run.metadata_json, '$.automation.name') AS automation_name,
               json_extract(run.metadata_json, '$.automation.context_mode') AS automation_context_mode,
               session.public_ref, session.name, session.space_id, session.origin_automation_id,
               session.archived_at, session.session_type,
               session.metadata AS session_metadata
        FROM chat_runs AS run
        JOIN sessions AS session ON session.session_id = run.session_id
        WHERE run.run_id = ${valid.parent.runId}
          AND run.session_id = ${valid.parent.sessionId}
        LIMIT 1
      `
  const parent = parentRows[0]
  const detached =
    parent === undefined
      ? new Set<string>()
      : yield* detachedWorkflowCalls(sql, valid.parent.runId, [valid.parent.toolCallId]).pipe(
          Effect.mapError((cause) =>
            writeError("spawn_agent", "storage", "Could not verify the detached workflow owner", {
              runId: valid.parent.runId,
              sessionId: valid.parent.sessionId,
              cause
            })
          )
        )
  const activeParent = parent?.status === STORED_RUN_STATUS.running || detached.size > 0
  if (parent === undefined || !activeParent || parent.archived_at !== null) {
    return yield* spawnError("invalid_parent", "The parent agent run is not active", valid.parent)
  }
  if (typeof parent.turn_id !== "string" || parent.turn_id.length === 0) {
    return yield* writeError("spawn_agent", "corrupt", "Parent Chat run has no durable turn id", {
      runId: parent.run_id,
      sessionId: parent.session_id
    })
  }
  const parentAutomation = yield* runAutomationOrigin(parent, "spawn_agent")
  const parentAutomationContextMode = yield* runAutomationContextMode(parent, "spawn_agent")
  if (parentAutomation !== null && parentAutomationContextMode === null) {
    return yield* writeError(
      "spawn_agent",
      "corrupt",
      "Parent Automation run has no captured context mode",
      { runId: parent.run_id, sessionId: parent.session_id }
    )
  }
  return { parent, parentAutomation, parentAutomationContextMode }
})
