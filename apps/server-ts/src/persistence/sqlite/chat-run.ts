import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { CancelInput } from "@arden-hq/protocol/chat"
import type { ChatAutomationOrigin, ChatWriteError } from "../chat/store.js"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import type { ChatEventStore } from "../events/store.js"
import { AutomationId } from "../automations/model.js"
import { writeError, type ChatWriteOperation } from "./chat-write-errors.js"
import { activeRunStatusList } from "./status-sets.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"

export interface RunRow {
  readonly run_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly status: string
  readonly client_id: string | null
  readonly assistant_message_id: string
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly approval_mode: "read_only" | "ask" | "safe" | "allow"
  readonly output_schema: string | null
  readonly last_seq: number | null
  readonly automation_task_id: string | null
  readonly automation_name: string | null
  readonly automation_context_mode: string | null
}

export const runAutomationOrigin = Effect.fn("SqliteChatWriteStore.runAutomationOrigin")(function* (
  row: Pick<RunRow, "run_id" | "session_id" | "automation_task_id" | "automation_name">,
  operation: ChatWriteOperation
): Effect.fn.Return<ChatAutomationOrigin | null, ChatWriteError> {
  if (row.automation_task_id === null && row.automation_name === null) return null
  if (row.automation_task_id !== null && row.automation_name !== null) {
    return { automationId: AutomationId.make(row.automation_task_id), name: row.automation_name }
  }
  return yield* writeError(operation, "corrupt", "Chat run has incomplete Automation identity", {
    runId: row.run_id,
    sessionId: row.session_id
  })
})

const decodeOutputSchema = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObjectSchema))

export const runOutputSchema = Effect.fn("SqliteChatWriteStore.runOutputSchema")(function* (
  row: Pick<RunRow, "run_id" | "session_id" | "output_schema">,
  operation: ChatWriteOperation
): Effect.fn.Return<JsonObject | null, ChatWriteError> {
  if (row.output_schema === null) return null
  return yield* decodeOutputSchema(row.output_schema).pipe(
    Effect.mapError((cause) =>
      writeError(operation, "corrupt", "Chat run has an invalid output schema", {
        runId: row.run_id,
        sessionId: row.session_id,
        cause
      })
    )
  )
})

const isAutomationContextMode = (value: string | null): value is AutomationContextMode =>
  value === "fresh" || value === "continue" || value === "fork"

export const runAutomationContextMode = Effect.fn("SqliteChatWriteStore.runAutomationContextMode")(
  function* (
    row: Pick<RunRow, "run_id" | "session_id" | "automation_task_id" | "automation_context_mode">,
    operation: ChatWriteOperation
  ): Effect.fn.Return<AutomationContextMode | null, ChatWriteError> {
    if (row.automation_task_id === null && row.automation_context_mode === null) return null
    if (row.automation_task_id !== null && isAutomationContextMode(row.automation_context_mode)) {
      return row.automation_context_mode
    }
    return yield* writeError(operation, "corrupt", "Chat run has invalid Automation context mode", {
      runId: row.run_id,
      sessionId: row.session_id
    })
  }
)

export const loadRun = Effect.fn("SqliteChatWriteStore.loadRun")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  operation: ChatWriteOperation
): Effect.fn.Return<RunRow, ChatWriteError> {
  const rows = yield* sql<RunRow>`
    SELECT run_id, session_id,
           json_extract(metadata_json, '$.turn_id') AS turn_id,
           status, client_id, assistant_message_id,
           model_id, reasoning_effort, last_seq,
           COALESCE(json_extract(metadata_json, '$.approval_mode'), 'ask') AS approval_mode,
           json_extract(metadata_json, '$.output_schema') AS output_schema,
           json_extract(metadata_json, '$.automation.task_id') AS automation_task_id,
           json_extract(metadata_json, '$.automation.name') AS automation_name,
           json_extract(metadata_json, '$.automation.context_mode') AS automation_context_mode
    FROM chat_runs
    WHERE run_id = ${runId}
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not load chat run", {
        runId,
        cause
      })
    )
  )
  const row = rows[0]
  if (row === undefined) {
    return yield* writeError(operation, "not_found", "Chat run was not found", { runId })
  }
  if (typeof row.turn_id !== "string" || row.turn_id.length === 0) {
    return yield* writeError(operation, "corrupt", "Chat run has no durable turn id", {
      runId,
      sessionId: row.session_id
    })
  }
  return row
})

export const loadActiveRun = Effect.fn("SqliteChatWriteStore.loadActiveRun")(function* (
  sql: SqlClient.SqlClient,
  input: CancelInput
): Effect.fn.Return<RunRow, ChatWriteError> {
  const rows =
    input.runId !== undefined
      ? yield* sql<RunRow>`
      SELECT run_id, session_id,
             json_extract(metadata_json, '$.turn_id') AS turn_id,
             status, client_id, assistant_message_id,
             model_id, reasoning_effort, last_seq,
             COALESCE(json_extract(metadata_json, '$.approval_mode'), 'ask') AS approval_mode,
             json_extract(metadata_json, '$.output_schema') AS output_schema,
             json_extract(metadata_json, '$.automation.task_id') AS automation_task_id,
             json_extract(metadata_json, '$.automation.name') AS automation_name,
             json_extract(metadata_json, '$.automation.context_mode') AS automation_context_mode
      FROM chat_runs
      WHERE run_id = ${input.runId}
        AND status IN ${activeRunStatusList}
      LIMIT 1
    `.pipe(
          Effect.mapError((cause) =>
            writeError("cancel", "storage", "Could not load active chat run", {
              runId: input.runId,
              cause
            })
          )
        )
      : yield* sql<RunRow>`
      SELECT run_id, session_id,
             json_extract(metadata_json, '$.turn_id') AS turn_id,
             status, client_id, assistant_message_id,
             model_id, reasoning_effort, last_seq,
             COALESCE(json_extract(metadata_json, '$.approval_mode'), 'ask') AS approval_mode,
             json_extract(metadata_json, '$.output_schema') AS output_schema,
             json_extract(metadata_json, '$.automation.task_id') AS automation_task_id,
             json_extract(metadata_json, '$.automation.name') AS automation_name,
             json_extract(metadata_json, '$.automation.context_mode') AS automation_context_mode
      FROM chat_runs
      WHERE session_id = ${input.sessionId}
        AND status IN ${activeRunStatusList}
      ORDER BY updated_at DESC, started_at DESC, run_id DESC
      LIMIT 1
    `.pipe(
          Effect.mapError((cause) =>
            writeError("cancel", "storage", "Could not load active chat run", {
              sessionId: input.sessionId,
              cause
            })
          )
        )
  const row = rows[0]
  if (row === undefined) {
    return yield* writeError("cancel", "not_found", "Active chat run was not found", {
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
    })
  }
  if (typeof row.turn_id !== "string" || row.turn_id.length === 0) {
    return yield* writeError("cancel", "corrupt", "Chat run has no durable turn id", {
      runId: row.run_id,
      sessionId: row.session_id
    })
  }
  return row
})

export const requireReceiptForRun = Effect.fn("SqliteChatWriteStore.requireReceiptForRun")(
  function* (
    sql: SqlClient.SqlClient,
    run: RunRow,
    operation: ChatWriteOperation
  ): Effect.fn.Return<void, ChatWriteError> {
    if (run.client_id === null) {
      return yield* writeError(operation, "corrupt", "Chat run has no client id", {
        sessionId: run.session_id,
        runId: run.run_id
      })
    }
    const rows = yield* sql<{ readonly run_id: string | null }>`
    SELECT run_id
    FROM chat_idempotency_keys
    WHERE session_id = ${run.session_id} AND client_id = ${run.client_id}
    LIMIT 1
  `.pipe(
      Effect.mapError((cause) =>
        writeError(operation, "storage", "Could not inspect run receipt", {
          sessionId: run.session_id,
          runId: run.run_id,
          cause
        })
      )
    )
    const receipt = rows[0]
    if (receipt?.run_id !== run.run_id) {
      return yield* writeError(
        operation,
        "corrupt",
        "Chat run idempotency receipt is missing or drifted",
        {
          sessionId: run.session_id,
          runId: run.run_id
        }
      )
    }
  }
)

export const setCheckpoint = Effect.fn("SqliteChatWriteStore.setCheckpoint")(function* (
  sql: SqlClient.SqlClient,
  chatEvents: ChatEventStore["Service"],
  sessionId: string,
  runId: string,
  sequence: number,
  operation: ChatWriteOperation
): Effect.fn.Return<void, ChatWriteError> {
  yield* sql`
    UPDATE chat_runs
    SET last_seq = CASE
      WHEN last_seq IS NULL OR last_seq < ${sequence} THEN ${sequence}
      ELSE last_seq
    END
    WHERE run_id = ${runId}
  `.pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not update run checkpoint", {
        sessionId,
        runId,
        cause
      })
    )
  )
  yield* chatEvents.setCheckpointInTransaction(sessionId, sequence).pipe(
    Effect.mapError((cause) =>
      writeError(operation, "storage", "Could not update session checkpoint", {
        sessionId,
        runId,
        cause
      })
    )
  )
})
