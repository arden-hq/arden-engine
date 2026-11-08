import type { ToolResult } from "@arden-hq/loop"
import { ToolEffectSchema } from "../../execution/tool-effect.js"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  ConnectionRequiredDataSchema,
  isConnectionRequiredData,
  pendingConnectionDecision,
  type PendingConnectionDecision
} from "../../connections/recovery.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import { ToolExecutionStoreError, type ToolExecutionIdentity } from "../tools/store.js"
import { decodeJson } from "./json.js"
import { TOOL_STATUSES, type ToolStatus } from "./status-sets.js"

export type ToolOperation =
  | "begin"
  | "complete"
  | "pause"
  | "uncertain"
  | "target"
  | "require_outcome_decision"
  | "recover"
  | "resolve"
  | "history"
  | "pending_approvals"
  | "pending_connections"

const isToolStatus = (status: string): status is ToolStatus =>
  (TOOL_STATUSES as readonly string[]).includes(status)

export type ToolApprovalKind = "tool_approval" | "tool_outcome"

export interface ValidToolExecutionIdentity extends Omit<ToolExecutionIdentity, "arguments"> {
  readonly arguments: JsonObject
}

export interface ToolCallRow {
  readonly session_id: string
  readonly tool_name: string
  readonly arguments_json: string
  readonly changes_state: number
  readonly status: string
  readonly result_json: string | null
}

export interface ChatRunRow {
  readonly status: string
}

export interface ApprovalRow {
  readonly run_id: string
  readonly session_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly action: string
  readonly scope: string
  readonly preview: string | null
  readonly diff: string | null
  readonly status: string
  readonly requested_at: string
  readonly resolved_at: string | null
  readonly expires_at: string | null
  readonly result_feedback: string | null
  readonly kind: string
  readonly payload_json: string
  readonly resolution_json: string | null
  readonly source?: "run" | "deferred"
  readonly work_json?: string | null
}

export interface UpdatedToolRow {
  readonly status: string
}

export interface LoadedToolRow {
  readonly row: ToolCallRow
  readonly status: ToolStatus
}

const ToolExecutionIdentitySchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  arguments: JsonObjectSchema,
  changesState: Schema.Boolean,
  effect: Schema.optionalKey(ToolEffectSchema),
  source: Schema.optionalKey(Schema.NonEmptyString)
})

const ContentBlockSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    media_type: Schema.String,
    data: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("audio"),
    media_type: Schema.String,
    data: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("context"),
    content_type: Schema.String,
    content: Schema.optionalKey(Schema.NullOr(Schema.String)),
    metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
  })
])

export const PersistedToolResultSchema = Schema.Struct({
  content: Schema.String,
  preview: Schema.String,
  is_error: Schema.optionalKey(Schema.Boolean),
  retryable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  data: Schema.optionalKey(Schema.NullOr(JsonObjectSchema)),
  message_extras: Schema.optionalKey(JsonObjectSchema),
  host: Schema.optionalKey(JsonObjectSchema),
  model_content: Schema.optionalKey(Schema.Array(ContentBlockSchema))
})

export type PersistedToolResult = (typeof PersistedToolResultSchema)["Type"]

export const argumentsEquivalent = Schema.toEquivalence(JsonObjectSchema)

const rawResultEquivalent = Schema.toEquivalence(PersistedToolResultSchema)

const canonicalResult = (result: PersistedToolResult): PersistedToolResult => ({
  content: result.content,
  preview: result.preview,
  ...(result.is_error === true ? { is_error: true } : {}),
  ...(result.retryable === undefined || result.retryable === null
    ? {}
    : { retryable: result.retryable }),
  ...(result.data === undefined || result.data === null ? {} : { data: result.data }),
  ...(result.message_extras === undefined || Object.keys(result.message_extras).length === 0
    ? {}
    : { message_extras: result.message_extras }),
  ...(result.host === undefined || Object.keys(result.host).length === 0
    ? {}
    : { host: result.host }),
  ...(result.model_content === undefined || result.model_content.length === 0
    ? {}
    : { model_content: result.model_content })
})

export const resultEquivalent = (left: PersistedToolResult, right: PersistedToolResult): boolean =>
  rawResultEquivalent(canonicalResult(left), canonicalResult(right))

export const canonicalToolArguments = (toolName: string, arguments_: JsonObject): JsonObject => {
  if (toolName !== "spawn_agent" || typeof arguments_.task !== "string") return arguments_
  return { ...arguments_, task: arguments_.task.trim() }
}

export const toolError = (
  operation: ToolOperation,
  reason: "invalid" | "not_found" | "conflict" | "blocked" | "corrupt" | "storage",
  message: string,
  identity?: Pick<ToolExecutionIdentity, "runId" | "toolCallId">,
  cause?: unknown
): ToolExecutionStoreError =>
  new ToolExecutionStoreError({
    operation,
    reason,
    message,
    ...(identity === undefined
      ? {}
      : {
          runId: identity.runId,
          toolCallId: identity.toolCallId
        }),
    ...(cause === undefined ? {} : { cause })
  })

export const preserveToolError =
  (operation: ToolOperation, identity?: Pick<ToolExecutionIdentity, "runId" | "toolCallId">) =>
  (cause: unknown): ToolExecutionStoreError =>
    cause instanceof ToolExecutionStoreError
      ? cause
      : toolError(operation, "storage", `Could not ${operation} tool execution`, identity, cause)

export const decodeIdentity = Effect.fn("SqliteToolExecutionStore.decodeIdentity")(function* (
  identity: ToolExecutionIdentity,
  operation: ToolOperation
): Effect.fn.Return<ValidToolExecutionIdentity, ToolExecutionStoreError> {
  return yield* Schema.decodeUnknownEffect(ToolExecutionIdentitySchema)(identity, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError((cause) =>
      toolError(operation, "invalid", "Invalid tool execution identity", identity, cause)
    )
  )
})

export const decodeResult = Effect.fn("SqliteToolExecutionStore.decodeResult")(function* (
  result: ToolResult,
  operation: ToolOperation,
  identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">
): Effect.fn.Return<PersistedToolResult, ToolExecutionStoreError> {
  return yield* Schema.decodeUnknownEffect(PersistedToolResultSchema)(result, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError((cause) =>
      toolError(operation, "invalid", "Tool result must be JSON-safe", identity, cause)
    )
  )
})

export const loadRow = Effect.fn("SqliteToolExecutionStore.loadRow")(function* (
  sql: SqlClient.SqlClient,
  identity: ValidToolExecutionIdentity,
  operation: ToolOperation
): Effect.fn.Return<ToolCallRow | null, ToolExecutionStoreError> {
  const rows = yield* sql<ToolCallRow>`
    SELECT session_id, tool_name, arguments_json, changes_state, status, result_json
    FROM tool_calls
    WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      toolError(operation, "storage", "Could not read tool execution", identity, cause)
    )
  )
  return rows[0] ?? null
})

export const validateRowIdentity = Effect.fn("SqliteToolExecutionStore.validateRowIdentity")(
  function* (
    row: ToolCallRow,
    identity: ValidToolExecutionIdentity,
    operation: ToolOperation
  ): Effect.fn.Return<ToolStatus, ToolExecutionStoreError> {
    if (
      row.session_id !== identity.sessionId ||
      row.tool_name !== identity.toolName ||
      row.changes_state !== Number(identity.changesState)
    ) {
      return yield* toolError(
        operation,
        "conflict",
        "Tool execution identity does not match its durable record",
        identity
      )
    }
    const storedArguments = yield* decodeJson(JsonObjectSchema, row.arguments_json).pipe(
      Effect.mapError((cause) =>
        toolError(operation, "corrupt", "Stored tool arguments are corrupt", identity, cause)
      )
    )
    if (
      !argumentsEquivalent(
        canonicalToolArguments(identity.toolName, storedArguments),
        canonicalToolArguments(identity.toolName, identity.arguments)
      )
    ) {
      return yield* toolError(
        operation,
        "conflict",
        "Tool arguments do not match the durable record",
        identity
      )
    }
    if (!isToolStatus(row.status)) {
      return yield* toolError(operation, "corrupt", "Stored tool status is invalid", identity)
    }
    return row.status
  }
)

export const decodeStoredResult = Effect.fn("SqliteToolExecutionStore.decodeStoredResult")(
  function* (
    row: ToolCallRow,
    identity: ValidToolExecutionIdentity,
    operation: ToolOperation
  ): Effect.fn.Return<PersistedToolResult, ToolExecutionStoreError> {
    if (row.result_json === null) {
      return yield* toolError(operation, "corrupt", "Stored tool result is missing", identity)
    }
    return yield* decodeJson(PersistedToolResultSchema, row.result_json).pipe(
      Effect.mapError((cause) =>
        toolError(operation, "corrupt", "Stored tool result is corrupt", identity, cause)
      )
    )
  }
)

export const requireRow = Effect.fn("SqliteToolExecutionStore.requireRow")(function* (
  sql: SqlClient.SqlClient,
  identity: ValidToolExecutionIdentity,
  operation: ToolOperation
): Effect.fn.Return<LoadedToolRow, ToolExecutionStoreError> {
  const row = yield* loadRow(sql, identity, operation)
  if (row === null) {
    return yield* toolError(operation, "not_found", "Tool execution was not started", identity)
  }
  const status = yield* validateRowIdentity(row, identity, operation)
  return { row, status }
})

export const decodePendingConnection = Effect.fn(
  "SqliteToolExecutionStore.decodePendingConnection"
)(function* (
  row: ApprovalRow,
  operation: "pending_connections" | "resolve"
): Effect.fn.Return<PendingConnectionDecision | null, ToolExecutionStoreError> {
  const payload = yield* decodeJson(JsonObjectSchema, row.payload_json).pipe(
    Effect.mapError((cause) =>
      toolError(
        operation,
        "corrupt",
        "Stored tool approval payload is corrupt",
        { runId: row.run_id, toolCallId: row.tool_call_id },
        cause
      )
    )
  )
  if (!isConnectionRequiredData(payload.approval_data)) return null
  const data = yield* Schema.decodeUnknownEffect(ConnectionRequiredDataSchema)(
    payload.approval_data,
    { onExcessProperty: "error" }
  ).pipe(
    Effect.mapError((cause) =>
      toolError(
        operation,
        "corrupt",
        "Stored connection recovery data is corrupt",
        { runId: row.run_id, toolCallId: row.tool_call_id },
        cause
      )
    )
  )
  const decision = pendingConnectionDecision(
    { runId: row.run_id, sessionId: row.session_id, toolCallId: row.tool_call_id },
    data
  )
  return {
    ...decision,
    snapshot: {
      ...decision.snapshot,
      decision_delivery: row.source === "deferred" ? "deferred" : "blocking"
    }
  }
})

export const loadApprovalRow = Effect.fn("SqliteToolExecutionStore.loadApprovalRow")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallId: string,
  operation: ToolOperation
): Effect.fn.Return<ApprovalRow | null, ToolExecutionStoreError> {
  const rows = yield* sql<ApprovalRow>`
    SELECT run_id, session_id, tool_call_id, tool_name, action, scope,
           preview, diff, status, requested_at, resolved_at, expires_at,
           result_feedback, kind, payload_json, resolution_json
    FROM tool_approvals
    WHERE run_id = ${runId} AND tool_call_id = ${toolCallId}
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      toolError(operation, "storage", "Could not read tool approval", { runId, toolCallId }, cause)
    )
  )
  return rows[0] ?? null
})
