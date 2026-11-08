import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { sanitizeApprovalPresentation, type ApprovalPresentation } from "@arden-hq/protocol/chat"
import { ApprovalPresentationSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Schema } from "effect"
import type { RuleSavedIn } from "@arden-hq/protocol/runs"
import { SqlClient } from "effect/unstable/sql"
import { ChatEventStore } from "../events/store.js"
import {
  ConnectionRequiredDataSchema,
  connectionNeededEvent,
  isConnectionRequiredData,
  pendingConnectionDecision
} from "../../connections/recovery.js"
import type { CommittedEventBatch, EventDraft } from "../events/model.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import {
  ToolExecutionStoreError,
  type ToolApprovalPrompt,
  type ToolExecutionApprovalContext,
  type ToolExecutionIdentity
} from "../tools/store.js"
import { spaceFolderGrantOf } from "../permissions/space-folder-approval.js"
import { grantFolderField } from "../permissions/grant-folder.js"
import { decodeJson, encodeJson } from "./json.js"
import type { ApprovalPermissionContext } from "./permissions.js"
import { toldKey, UnitOfWork } from "../unit-of-work.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { journalAskChange } from "./ask-changes.js"
import {
  type ToolApprovalKind,
  type ValidToolExecutionIdentity,
  type UpdatedToolRow,
  argumentsEquivalent,
  toolError,
  loadApprovalRow
} from "./tool-rows.js"
import { activeRunStatusList } from "./status-sets.js"
import { loadPendingDecisionRoutes, type DecisionRouteRef } from "./decision-route-journal.js"
import { workOf } from "./run-approvals.js"
import { resumeToolCoordinator } from "./tool-coordinator.js"
import { detachedWorkflowCalls } from "./detached-workflow-calls.js"

export interface PendingToolApprovalInput {
  readonly runId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly kind: ToolApprovalKind
  readonly action: string
  readonly scope: string
  readonly preview: string | null
  readonly diff?: string | null
  readonly presentation?: ApprovalPresentation
  readonly description: string | null
  readonly data?: JsonObject
  readonly permissionContext?: ApprovalPermissionContext
}

const ToolApprovalPromptSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  detail: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  presentation: Schema.optionalKey(ApprovalPresentationSchema),
  data: Schema.optionalKey(JsonObjectSchema)
})

export const decodePrompt = Effect.fn("SqliteToolExecutionStore.decodePrompt")(function* (
  prompt: ToolApprovalPrompt,
  identity: ToolExecutionIdentity
): Effect.fn.Return<ToolApprovalPrompt, ToolExecutionStoreError> {
  const presentation =
    prompt.presentation === undefined
      ? undefined
      : sanitizeApprovalPresentation(prompt.presentation)
  if (prompt.presentation !== undefined && presentation === undefined) {
    return yield* toolError("pause", "invalid", "Invalid tool approval presentation", identity)
  }
  const sanitized = {
    ...prompt,
    ...(presentation === undefined ? {} : { presentation })
  }
  return yield* Schema.decodeUnknownEffect(ToolApprovalPromptSchema)(sanitized, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError((cause) =>
      toolError("pause", "invalid", "Invalid tool approval prompt", identity, cause)
    )
  )
})

const approvalIdentity = (
  input: Pick<PendingToolApprovalInput, "runId" | "toolCallId">
): Pick<ToolExecutionIdentity, "runId" | "toolCallId"> => input

const approvalPresentationPayload = (presentation: ApprovalPresentation): JsonObject => ({
  title: presentation.title,
  ...(presentation.subject === undefined ? {} : { subject: presentation.subject }),
  fields: presentation.fields.map((field) => ({ label: field.label, value: field.value })),
  ...(presentation.body === undefined
    ? {}
    : { body: { label: presentation.body.label, text: presentation.body.text } }),
  ...(presentation.approve_label === undefined
    ? {}
    : { approve_label: presentation.approve_label }),
  ...(presentation.reject_label === undefined ? {} : { reject_label: presentation.reject_label }),
  ...(presentation.note === undefined ? {} : { note: presentation.note }),
  ...(presentation.why === undefined ? {} : { why: presentation.why }),
  ...(presentation.grant_label === undefined ? {} : { grant_label: presentation.grant_label }),
  ...(presentation.grant_rule === undefined ? {} : { grant_rule: presentation.grant_rule })
})

const canAttachFolderToSpace = (input: PendingToolApprovalInput): boolean =>
  spaceFolderGrantOf(input.toolName, input.data) !== undefined

export const cardStanding = (input: {
  readonly granted: boolean
  readonly data: JsonObject | undefined
  readonly savedIn: JsonObject[string] | undefined
}): { readonly grantStanding?: true; readonly data?: JsonObject } => {
  const savedIn = input.savedIn === undefined ? {} : { saved_in: input.savedIn }
  return {
    ...(input.granted ? { grantStanding: true } : {}),
    ...(input.data === undefined && input.savedIn === undefined
      ? {}
      : { data: { ...input.data, ...savedIn } })
  }
}

const approvalGrantPayload = (input: PendingToolApprovalInput): JsonObject => {
  const context = input.permissionContext
  if (context === undefined) return {}
  const grant = { grant_principal: context.principal, rule_places: context.places }
  if (context.mcp === null) return grant
  return {
    ...grant,
    tool_source: context.mcp.source,
    mcp_updated_at: context.mcp.serverUpdatedAt
  }
}

const approvalGrantEvent = (
  input: PendingToolApprovalInput
): { readonly rule_places?: ReadonlyArray<RuleSavedIn> } =>
  input.permissionContext === undefined ? {} : { rule_places: input.permissionContext.places }

export const approvalPayload = (input: PendingToolApprovalInput): JsonObject => ({
  ...(input.description === null ? {} : { description: input.description }),
  ...(input.presentation === undefined
    ? {}
    : { presentation: approvalPresentationPayload(input.presentation) }),
  ...(input.data === undefined ? {} : { approval_data: input.data }),
  ...(canAttachFolderToSpace(input) ? { can_attach_folder_to_space: true } : {}),
  ...approvalGrantPayload(input)
})

const approvalNeededDraft = (
  input: PendingToolApprovalInput,
  sourceKind: "run" | "deferred"
): EventDraft => ({
  event: {
    type: "approval_needed",
    tool_id: input.toolCallId,
    name: input.toolName,
    content_preview: input.preview,
    ...(input.diff === undefined ? {} : { diff: input.diff }),
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    run_id: input.runId,
    session_id: input.sessionId,
    decision_route: {
      source_kind: sourceKind,
      source_session_id: input.sessionId,
      basis: "source_v1"
    },
    action: input.action,
    scope: input.scope,
    ...(canAttachFolderToSpace(input) ? { can_attach_folder_to_space: true } : {}),
    ...grantFolderField(input.toolName, input.data),
    ...approvalGrantEvent(input)
  } satisfies ChatProjectionEvent,
  runId: input.runId
})

export const pendingDecisionDraft = Effect.fn("SqliteToolExecutionStore.pendingDecisionDraft")(
  function* (
    input: PendingToolApprovalInput,
    operation: "pause" | "uncertain" | "recover",
    sourceKind: "run" | "deferred" = "run"
  ): Effect.fn.Return<EventDraft, ToolExecutionStoreError> {
    if (isConnectionRequiredData(input.data)) {
      const data = yield* Schema.decodeUnknownEffect(ConnectionRequiredDataSchema)(input.data, {
        onExcessProperty: "error"
      }).pipe(
        Effect.mapError((cause) =>
          toolError(
            operation,
            "corrupt",
            "Connection recovery data is invalid",
            approvalIdentity(input),
            cause
          )
        )
      )
      return {
        event: {
          ...connectionNeededEvent(pendingConnectionDecision(input, data)),
          decision_route: {
            source_kind: sourceKind,
            source_session_id: input.sessionId,
            basis: "source_v1"
          }
        },
        runId: input.runId
      }
    }
    return approvalNeededDraft(input, sourceKind)
  }
)

export const ensurePendingToolApprovalInTransaction = Effect.fn(
  "SqliteToolExecutionStore.ensurePendingToolApprovalInTransaction"
)(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: Pick<
    SessionLifecycleEvents["Service"],
    "appendEventInTransaction" | "appendInTransaction"
  >,
  input: PendingToolApprovalInput,
  requestedAt: string,
  operation: "pause" | "uncertain" | "recover"
): Effect.fn.Return<EventDraft | null, ToolExecutionStoreError, UnitOfWork> {
  const decisionDraft = yield* pendingDecisionDraft(input, operation)
  const announced = (draft: EventDraft) =>
    Effect.gen(function* () {
      yield* journalAskChange(sql, sessionEvents, {
        kind: "approval_opened",
        runId: input.runId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName
      })
      return draft
    }).pipe(
      Effect.mapError((cause) =>
        toolError(
          operation,
          "storage",
          "Could not journal the waiting decision",
          approvalIdentity(input),
          cause
        )
      )
    )
  const payload = approvalPayload(input)
  const payloadJson = yield* encodeJson(JsonObjectSchema, payload).pipe(
    Effect.mapError((cause) =>
      toolError(
        operation,
        "corrupt",
        "Tool approval payload is invalid",
        approvalIdentity(input),
        cause
      )
    )
  )
  const existing = yield* loadApprovalRow(sql, input.runId, input.toolCallId, operation)
  if (existing !== null) {
    if (
      existing.kind === "tool_approval" &&
      existing.status === "approved" &&
      existing.session_id === input.sessionId &&
      existing.tool_name === input.toolName
    ) {
      yield* sql`
        UPDATE tool_approvals
        SET action = ${input.action}, scope = ${input.scope}, preview = ${input.preview},
            diff = ${input.diff ?? null}, status = 'pending', requested_at = ${requestedAt},
            resolved_at = NULL, expires_at = NULL, result_feedback = NULL,
            kind = ${input.kind}, payload_json = ${payloadJson}, resolution_json = NULL
        WHERE run_id = ${input.runId} AND tool_call_id = ${input.toolCallId}
          AND kind = 'tool_approval' AND status = 'approved'
      `.pipe(
        Effect.mapError((cause) =>
          toolError(
            operation,
            "storage",
            "Could not record the next tool decision",
            approvalIdentity(input),
            cause
          )
        )
      )
      return yield* announced(decisionDraft)
    }
    const storedPayload = yield* decodeJson(JsonObjectSchema, existing.payload_json).pipe(
      Effect.mapError((cause) =>
        toolError(
          operation,
          "corrupt",
          "Stored tool approval payload is corrupt",
          approvalIdentity(input),
          cause
        )
      )
    )
    if (
      existing.run_id !== input.runId ||
      existing.session_id !== input.sessionId ||
      existing.tool_call_id !== input.toolCallId ||
      existing.tool_name !== input.toolName ||
      existing.action !== input.action ||
      existing.scope !== input.scope ||
      existing.preview !== input.preview ||
      existing.diff !== (input.diff ?? null) ||
      existing.status !== "pending" ||
      existing.resolved_at !== null ||
      existing.result_feedback !== null ||
      existing.kind !== input.kind ||
      existing.resolution_json !== null ||
      !argumentsEquivalent(storedPayload, payload)
    ) {
      return yield* toolError(
        operation,
        "conflict",
        "Tool approval already has different durable state",
        approvalIdentity(input)
      )
    }
    return null
  }

  yield* sql`
    INSERT INTO tool_approvals (
      run_id, session_id, tool_call_id, tool_name, action, scope,
      preview, diff, status, requested_at, resolved_at, expires_at,
      result_feedback, kind, payload_json, resolution_json
    ) VALUES (
      ${input.runId}, ${input.sessionId}, ${input.toolCallId}, ${input.toolName},
      ${input.action}, ${input.scope}, ${input.preview}, ${input.diff ?? null}, 'pending',
      ${requestedAt}, NULL, NULL, NULL, ${input.kind}, ${payloadJson}, NULL
    )
  `.pipe(
    Effect.mapError((cause) =>
      toolError(
        operation,
        "storage",
        "Could not record pending tool approval",
        approvalIdentity(input),
        cause
      )
    )
  )
  return yield* announced(decisionDraft)
})

export const approvalInput = (
  identity: ValidToolExecutionIdentity,
  kind: ToolApprovalKind,
  action: string,
  preview: string | null,
  description: string | null,
  prompt?: Pick<ToolApprovalPrompt, "diff" | "presentation" | "data">,
  permissionContext?: ApprovalPermissionContext
): PendingToolApprovalInput => ({
  runId: identity.runId,
  sessionId: identity.sessionId,
  toolCallId: identity.toolCallId,
  toolName: identity.toolName,
  kind,
  action,
  scope: identity.changesState ? "state_change" : "read_only",
  preview,
  description,
  ...(prompt?.diff === undefined ? {} : { diff: prompt.diff }),
  ...(prompt?.presentation === undefined ? {} : { presentation: prompt.presentation }),
  ...(prompt?.data === undefined ? {} : { data: prompt.data }),
  ...(permissionContext === undefined ? {} : { permissionContext })
})

export const setRunPending = Effect.fn("SqliteToolExecutionStore.setRunPending")(function* (
  sql: SqlClient.SqlClient,
  identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">,
  timestamp: string,
  operation: "pause" | "uncertain"
): Effect.fn.Return<void, ToolExecutionStoreError> {
  const updated = yield* sql<UpdatedToolRow>`
    UPDATE chat_runs
    SET status = 'pending', updated_at = ${timestamp}
    WHERE run_id = ${identity.runId}
      AND status IN ${activeRunStatusList}
    RETURNING status
  `.pipe(
    Effect.mapError((cause) =>
      toolError(operation, "storage", "Could not pause the owning chat run", identity, cause)
    )
  )
  if (updated.length !== 1) {
    const detached = yield* detachedWorkflowCalls(sql, identity.runId, [identity.toolCallId]).pipe(
      Effect.mapError((cause) =>
        toolError(operation, "storage", "Could not read the detached script owner", identity, cause)
      )
    )
    if (detached.has(identity.toolCallId)) return
    return yield* toolError(operation, "conflict", "Owning chat run is not active", identity)
  }
})

export const appendApprovalDraft = Effect.fn("SqliteToolExecutionStore.appendApprovalDraft")(
  function* (
    sql: SqlClient.SqlClient,
    chatEvents: ChatEventStore["Service"],
    sessionId: string,
    identity: Pick<ToolExecutionIdentity, "runId" | "toolCallId">,
    operation: "pause" | "uncertain",
    draft: EventDraft | null
  ): Effect.fn.Return<CommittedEventBatch | null, ToolExecutionStoreError, UnitOfWork> {
    if (draft === null) return null
    const detached = yield* detachedWorkflowCalls(sql, identity.runId, [identity.toolCallId]).pipe(
      Effect.mapError((cause) =>
        toolError(
          operation,
          "storage",
          "Could not read the approval's script owner",
          identity,
          cause
        )
      )
    )
    const committed = yield* chatEvents
      .appendInTransaction({
        sessionId,
        events: [detached.has(identity.toolCallId) ? { ...draft, admission: "detached" } : draft]
      })
      .pipe(
        Effect.mapError((cause) =>
          toolError(operation, "storage", "Could not append tool approval event", identity, cause)
        )
      )
    yield* chatEvents
      .setCheckpointInTransaction(sessionId, committed.headSequence)
      .pipe(
        Effect.mapError((cause) =>
          toolError(
            operation,
            "storage",
            "Could not advance the tool approval checkpoint",
            identity,
            cause
          )
        )
      )
    yield* sql`
    UPDATE chat_runs
    SET last_seq = ${committed.headSequence}
    WHERE run_id = ${identity.runId}
  `.pipe(
      Effect.mapError((cause) =>
        toolError(
          operation,
          "storage",
          "Could not advance the owning run event sequence",
          identity,
          cause
        )
      )
    )
    return committed
  }
)

export const appendEscalatedApprovalDraft = Effect.fn(
  "SqliteToolExecutionStore.appendEscalatedApprovalDraft"
)(function* (
  sql: SqlClient.SqlClient,
  chatEvents: ChatEventStore["Service"],
  sourceSessionId: string,
  draft: EventDraft,
  capturedRoutes?: ReadonlyArray<DecisionRouteRef>,
  includeSource = false
): Effect.fn.Return<void, ToolExecutionStoreError, UnitOfWork> {
  if (
    !("tool_id" in draft.event) ||
    typeof draft.event.tool_id !== "string" ||
    typeof draft.runId !== "string"
  )
    return yield* toolError("pause", "invalid", "Escalated decision has no source identity")
  const routes =
    capturedRoutes ??
    (yield* loadPendingDecisionRoutes(sql, "run", draft.runId, draft.event.tool_id).pipe(
      Effect.mapError((cause) =>
        toolError("pause", "storage", "Could not read decision recipients", undefined, cause)
      )
    ))
  yield* (yield* UnitOfWork).markTold(toldKey.card(draft.runId, draft.event.tool_id))
  const recipients = includeSource
    ? routes
    : routes.filter((route) => route.viewer_session_id !== sourceSessionId)
  const work =
    draft.event.type === "approval_needed"
      ? workOf(
          (yield* sql<{ readonly work_json: string | null }>`
            SELECT COALESCE(json_extract(metadata_json, '$.run_context.belongs_to'),
              json_extract(metadata_json, '$.run_context.origin')) AS work_json
            FROM chat_runs WHERE run_id = ${draft.runId}`.pipe(
            Effect.mapError((cause) =>
              toolError("pause", "storage", "Could not read the asking run", undefined, cause)
            )
          ))[0]?.work_json ?? null
        )
      : null
  yield* Effect.forEach(
    recipients,
    Effect.fn("SqliteToolExecutionStore.escalateApproval")(function* (recipient) {
      const committed = yield* chatEvents
        .appendInTransaction({
          sessionId: recipient.viewer_session_id,
          events: [
            {
              ...draft,
              event: {
                ...draft.event,
                decision_route: {
                  source_kind: recipient.source_kind,
                  source_session_id: sourceSessionId,
                  basis: recipient.basis
                },
                ...(work === null || recipient.viewer_session_id === sourceSessionId
                  ? {}
                  : { work })
              },
              admission: "detached"
            }
          ]
        })
        .pipe(
          Effect.mapError((cause) =>
            toolError(
              "pause",
              "storage",
              "Could not notify the parent Chat of an agent approval",
              undefined,
              cause
            )
          )
        )
      yield* chatEvents
        .setCheckpointInTransaction(recipient.viewer_session_id, committed.headSequence)
        .pipe(
          Effect.mapError((cause) =>
            toolError(
              "pause",
              "storage",
              "Could not checkpoint the parent agent approval",
              undefined,
              cause
            )
          )
        )
    }),
    { discard: true }
  )
})

export const resumeApprovedTool = Effect.fn("SqliteToolExecutionStore.resumeApprovedTool")(
  function* (
    sql: SqlClient.SqlClient,
    identity: ValidToolExecutionIdentity
  ): Effect.fn.Return<ToolExecutionApprovalContext | undefined, ToolExecutionStoreError> {
    const approval = yield* loadApprovalRow(sql, identity.runId, identity.toolCallId, "begin")
    if (approval === null) {
      yield* resumeToolCoordinator(sql, identity).pipe(
        Effect.mapError((cause) =>
          cause instanceof ToolExecutionStoreError
            ? cause
            : toolError("begin", "storage", "Could not resume the coordinator", identity, cause)
        )
      )
      return undefined
    }
    if (
      approval.session_id !== identity.sessionId ||
      approval.tool_name !== identity.toolName ||
      approval.kind !== "tool_approval" ||
      approval.status !== "approved" ||
      approval.resolved_at === null ||
      approval.resolution_json === null
    ) {
      return yield* toolError(
        "begin",
        "corrupt",
        "Approved tool execution has no approval decision",
        identity
      )
    }
    const updated = yield* sql<UpdatedToolRow>`
    UPDATE tool_calls
    SET status = 'running'
    WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
      AND status = 'ready'
    RETURNING status
  `.pipe(
      Effect.mapError((cause) =>
        toolError("begin", "storage", "Could not resume approved tool execution", identity, cause)
      )
    )
    if (updated.length !== 1) {
      return yield* toolError(
        "begin",
        "conflict",
        "Approved tool execution changed before resume",
        identity
      )
    }
    const payload = yield* decodeJson(JsonObjectSchema, approval.payload_json).pipe(
      Effect.mapError((cause) =>
        toolError("begin", "corrupt", "Stored tool approval payload is corrupt", identity, cause)
      )
    )
    const approvalData = payload.approval_data
    if (
      approvalData !== undefined &&
      (typeof approvalData !== "object" || approvalData === null || Array.isArray(approvalData))
    ) {
      return yield* toolError("begin", "corrupt", "Stored tool approval data is invalid", identity)
    }
    if (isConnectionRequiredData(approvalData)) return undefined
    const resolution = yield* decodeJson(JsonObjectSchema, approval.resolution_json).pipe(
      Effect.mapError((cause) =>
        toolError("begin", "corrupt", "Stored tool approval resolution is corrupt", identity, cause)
      )
    )
    const edited =
      resolution.edited_arguments === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(
            Schema.Struct({ requested: JsonObjectSchema, arguments: JsonObjectSchema })
          )({ requested: identity.arguments, arguments: resolution.edited_arguments }).pipe(
            Effect.mapError((cause) =>
              toolError("begin", "corrupt", "Stored edited arguments are invalid", identity, cause)
            )
          )
    if (resolution.alternative !== undefined && resolution.alternative !== "draft") {
      return yield* toolError(
        "begin",
        "corrupt",
        "Stored approval alternative is invalid",
        identity
      )
    }
    return {
      approved: true,
      feedback: approval.result_feedback,
      ...cardStanding({
        granted: resolution.grant_standing === true && resolution.standing_skipped !== true,
        data: approvalData as JsonObject | undefined,
        savedIn: resolution.saved_in
      }),
      ...(edited === undefined ? {} : { edited }),
      ...(resolution.alternative === "draft" ? { alternative: "draft" as const } : {})
    }
  }
)
