import { AGENT_MODE } from "@arden-hq/protocol/chat"
import { DateTime, Effect } from "effect"
import { journalHeadSequenceSql } from "@arden-hq/journal/effect"
import { type ChatWriteSpawnAgentResult } from "../chat/store.js"
import type { IntelligenceSettingsStore } from "../settings/store.js"
import { JsonObjectSchema } from "../json.js"
import { readAgentSessionMetadata } from "../../sessions/agent-mode.js"
import { settleToolExecutionInTransaction } from "./tool-receipts.js"
import { decodeJson } from "./json.js"
import { writeError } from "./chat-write-errors.js"
import { runAutomationContextMode, runAutomationOrigin, runOutputSchema } from "./chat-run.js"
import { schedulingForSession } from "./chat-session.js"
import { loadActiveMessages, loadMintedMessageIds } from "./chat-transcript.js"
import { spawnAgentInputSchema } from "./chat-agent-spawn-input.js"
import type { PersistenceDeps } from "./deps.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { type ExistingChildRow, agentSpawnResult, spawnError } from "./chat-agent-spawn-rows.js"

export const existingSpawnChild = Effect.fn("SqliteChatWriteStore.existingSpawnChild")(function* (
  sql: PersistenceDeps["writer"]["sql"],
  valid: typeof spawnAgentInputSchema.Type,
  controls: Effect.Success<ReturnType<IntelligenceSettingsStore["Service"]["settings"]>>
) {
  const existingRows = yield* sql<ExistingChildRow>`
        SELECT session.session_id, session.public_ref, session.name, session.metadata, session.chat_model,
               session.session_type, session.space_id,
               run.run_id, run.status, run.assistant_message_id, run.model_id,
               run.reasoning_effort, run.last_seq,
               ${journalHeadSequenceSql(sql, sql.literal("session.session_id"))} AS head_sequence,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               json_extract(run.metadata_json, '$.output_schema') AS output_schema,
               json_extract(run.metadata_json, '$.automation.task_id') AS automation_task_id,
               json_extract(run.metadata_json, '$.automation.name') AS automation_name,
               json_extract(run.metadata_json, '$.automation.context_mode') AS automation_context_mode
        FROM sessions AS session
        JOIN chat_runs AS run ON run.session_id = session.session_id
        WHERE session.session_type = 'agent'
          AND session.parent_run_id = ${valid.parent.runId}
          AND session.parent_tool_call_id = ${valid.parent.toolCallId}
          AND session.archived_at IS NULL
        ORDER BY run.started_at, run.run_id
        LIMIT 1
      `
  const existing = existingRows[0]
  if (existing !== undefined) {
    if (!isActiveRunStatus(existing.status)) {
      return yield* spawnError(
        "invalid_parent",
        "The existing child agent run is no longer active",
        valid.parent
      )
    }
    const existingMetadata = yield* decodeJson(JsonObjectSchema, existing.metadata ?? "{}").pipe(
      Effect.mapError((cause) =>
        writeError("spawn_agent", "corrupt", "Agent metadata is corrupt", {
          sessionId: existing.session_id,
          runId: existing.run_id,
          cause
        })
      )
    )
    const agent = readAgentSessionMetadata(existingMetadata)
    if (
      agent === null ||
      agent.mode !== valid.mode ||
      (agent.mode === AGENT_MODE.code && agent.workspace === null)
    ) {
      return yield* writeError("spawn_agent", "corrupt", "Agent sandbox metadata is invalid", {
        sessionId: existing.session_id,
        runId: existing.run_id
      })
    }
    const result = agentSpawnResult(
      {
        sessionId: existing.session_id,
        sessionRef: existing.public_ref,
        name: existing.name
      },
      existing.run_id,
      agent.mode,
      valid.parent
    )
    const settled = yield* settleToolExecutionInTransaction(
      sql,
      valid.parent,
      result,
      DateTime.formatIso(yield* DateTime.now)
    )
    const activeMessages = yield* loadActiveMessages(sql, existing.session_id, "spawn_agent")
    const automation = yield* runAutomationOrigin(existing, "spawn_agent")
    const automationContextMode = yield* runAutomationContextMode(existing, "spawn_agent")
    const scheduling = yield* schedulingForSession(
      sql,
      existing.session_id,
      existing.session_type,
      controls.maxConcurrentAgents,
      "spawn_agent"
    )
    const mintedMessageIds = yield* loadMintedMessageIds(
      sql,
      existing.session_id,
      existing.turn_id,
      "spawn_agent"
    )
    return {
      result: settled,
      child: {
        runId: existing.run_id,
        sessionId: existing.session_id,
        assistantMessageId: existing.assistant_message_id,
        mintedMessageIds,
        model: existing.model_id,
        reasoningEffort: existing.reasoning_effort,
        approvalMode: "allow",
        outputSchema: yield* runOutputSchema(existing, "spawn_agent"),
        automation,
        automationContextMode,
        turnId: existing.turn_id,
        activeMessages,
        eventSequence: existing.head_sequence ?? existing.last_seq ?? 0,
        scheduling
      }
    } satisfies ChatWriteSpawnAgentResult
  }
  return undefined
})
