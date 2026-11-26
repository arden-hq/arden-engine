import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { APPROVAL_ASKED, APPROVAL_ASKER } from "@arden-hq/protocol/chat"
import { ApprovalPresentationSchema } from "@arden-hq/protocol/effect/chat"
import {
  cleanApprovalDraft,
  draftPayload,
  wireApprovalPresentation,
  type ApprovalPresentationDraft
} from "../tools/approval-draft.js"
import { Effect, Schema } from "effect"
import {
  ConnectionRequiredDataSchema,
  connectionNeededEvent,
  isConnectionRequiredData,
  pendingConnectionDecision
} from "../../connections/recovery.js"
import type { EventDraft } from "../events/model.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import {
  ToolExecutionStoreError,
  type ToolApprovalPrompt,
  type ToolExecutionIdentity
} from "../tools/store.js"
import { spaceFolderGrantOf } from "../permissions/space-folder-approval.js"
import { grantFolderOf } from "../permissions/grant-folder.js"
import type { ApprovalPermissionContext } from "./permissions.js"
import { type ToolApprovalKind, toolError } from "./tool-rows.js"
import { approvalCard, approvalDiff, approvalPreview } from "./run-approvals.js"

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
  readonly presentation?: ApprovalPresentationDraft
  readonly description: string | null
  readonly data?: JsonObject
  readonly permissionContext?: ApprovalPermissionContext
}

const ToolApprovalPromptSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  detail: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(JsonObjectSchema)
})

const isWirePresentation = Schema.is(ApprovalPresentationSchema)

export const decodePrompt = Effect.fn("SqliteToolExecutionStore.decodePrompt")(function* (
  prompt: ToolApprovalPrompt,
  identity: ToolExecutionIdentity
): Effect.fn.Return<ToolApprovalPrompt, ToolExecutionStoreError> {
  const presentation =
    prompt.presentation === undefined ? undefined : cleanApprovalDraft(prompt.presentation)
  if (
    prompt.presentation !== undefined &&
    (presentation === undefined || !isWirePresentation(wireApprovalPresentation(presentation)))
  ) {
    return yield* toolError("pause", "invalid", "Invalid tool approval presentation", identity)
  }
  const { presentation: _authored, ...rest } = prompt
  const decoded = yield* Schema.decodeUnknownEffect(ToolApprovalPromptSchema)(rest, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError((cause) =>
      toolError("pause", "invalid", "Invalid tool approval prompt", identity, cause)
    )
  )
  return presentation === undefined ? decoded : { ...decoded, presentation }
})

export const approvalIdentity = (
  input: Pick<PendingToolApprovalInput, "runId" | "toolCallId">
): Pick<ToolExecutionIdentity, "runId" | "toolCallId"> => input

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

export const approvalPayload = (input: PendingToolApprovalInput): JsonObject => ({
  ...(input.description === null ? {} : { description: input.description }),
  ...(input.presentation === undefined ? {} : { presentation: draftPayload(input.presentation) }),
  ...(input.data === undefined ? {} : { approval_data: input.data }),
  ...(canAttachFolderToSpace(input) ? { can_attach_folder_to_space: true } : {}),
  ...approvalGrantPayload(input)
})

const approvalNeededDraft = (
  input: PendingToolApprovalInput,
  sourceKind: "run" | "deferred",
  askedAt: string
): EventDraft => ({
  event: {
    type: "approval_needed",
    tool_id: input.toolCallId,
    asked: { kind: APPROVAL_ASKED.recorded, at: askedAt },
    name: input.toolName,
    preview: approvalPreview(input.preview),
    diff: approvalDiff(input.diff ?? null),
    card: approvalCard(
      input.presentation === undefined ? undefined : wireApprovalPresentation(input.presentation)
    ),
    run_id: input.runId,
    session_id: input.sessionId,
    decision_route: {
      source_kind: sourceKind,
      source_session_id: input.sessionId,
      basis: "source_v1"
    },
    action: input.action,
    rule_places: input.permissionContext?.places ?? [],
    can_attach_folder_to_space: canAttachFolderToSpace(input),
    grant_folder: grantFolderOf(input.toolName, input.data),
    asker: { kind: APPROVAL_ASKER.chat }
  } satisfies ChatProjectionEvent,
  runId: input.runId
})

export const pendingDecisionDraft = Effect.fn("SqliteToolExecutionStore.pendingDecisionDraft")(
  function* (
    input: PendingToolApprovalInput,
    operation: "pause" | "uncertain" | "recover",
    askedAt: string,
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
        event: connectionNeededEvent(pendingConnectionDecision(input, data, sourceKind), {
          source_kind: sourceKind,
          source_session_id: input.sessionId,
          basis: "source_v1"
        }),
        runId: input.runId
      }
    }
    return approvalNeededDraft(input, sourceKind, askedAt)
  }
)
