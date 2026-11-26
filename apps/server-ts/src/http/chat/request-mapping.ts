import {
  ANSWER_SHAPE,
  APPROVAL_REPLY,
  APPROVED_AS,
  ARGUMENT_EDITS,
  CANCEL_TARGET,
  CHAT_CAPTURE,
  CONNECTION_RESULT,
  DECISION_ASKED,
  FOLDER_ATTACH,
  GRANT_LIST,
  QUEUED_FAILURE,
  RECEIPT_RUN,
  REQUESTED_MODE,
  SENT_FROM,
  STANDING_GRANT,
  TOOL_DECISION,
  type ChatApprovalMode,
  type ChatSentFrom,
  type ConnectionResultText,
  type DecisionAsked,
  type QueuedChatMessage,
  type RequestedApprovalMode,
  type SentFrom,
  type ToolDecision
} from "@arden-hq/protocol/chat"
import type {
  CancelRequestSchema,
  ChatReceiptResponseSchema,
  ChatRequestSchema
} from "@arden-hq/protocol/effect/chat"
import type { ChatQueuedMessage } from "../../persistence/chat/store.js"
import type { ApprovalAlternativeInput, ApprovalEditsInput } from "../../persistence/tools/store.js"
import type { ChatMessageFields, RunCancelTarget } from "../../persistence/chat/send-contracts.js"

type ChatRequest = typeof ChatRequestSchema.Type

type AnswerSchema = Extract<
  ChatRequest["output_schema"],
  { readonly kind: typeof ANSWER_SHAPE.schema }
>["schema"]

export const requestedMode = (mode: RequestedApprovalMode): ChatApprovalMode | undefined =>
  mode.kind === REQUESTED_MODE.mode ? mode.mode : undefined

export const sentFromOf = (sentFrom: SentFrom): ChatSentFrom | undefined =>
  sentFrom.kind === SENT_FROM.surface ? sentFrom.surface : undefined

const sentFromWire = (sentFrom: ChatSentFrom | undefined): SentFrom =>
  sentFrom === undefined
    ? { kind: SENT_FROM.typed }
    : { kind: SENT_FROM.surface, surface: sentFrom }

export const messageExtras = (
  payload: ChatRequest
): Pick<
  ChatMessageFields,
  "approvalReply" | "outputSchema" | "capture" | "replyTo" | "images"
> => ({
  ...(payload.approval_reply.kind === APPROVAL_REPLY.deny
    ? {
        approvalReply: {
          runId: payload.approval_reply.run_id,
          toolId: payload.approval_reply.tool_id
        }
      }
    : {}),
  ...(payload.output_schema.kind === ANSWER_SHAPE.schema
    ? { outputSchema: payload.output_schema.schema }
    : {}),
  ...(payload.capture.kind === CHAT_CAPTURE.capture ? { capture: payload.capture.via } : {}),
  ...(payload.reply_to.length === 0
    ? {}
    : {
        replyTo: payload.reply_to.map((quoted) => ({
          messageId: quoted.message_id,
          role: quoted.role,
          content: quoted.content
        }))
      }),
  ...(payload.images.length === 0
    ? {}
    : {
        images: payload.images.map((image) => ({
          mediaType: image.media_type,
          data: image.data
        }))
      })
})

export const outputSchemaOf = (payload: ChatRequest): AnswerSchema | undefined =>
  payload.output_schema.kind === ANSWER_SHAPE.schema ? payload.output_schema.schema : undefined

export interface DecisionFields {
  readonly result: string
  readonly approved?: boolean
  readonly grantStanding?: boolean
  readonly grantList?: "space" | "global"
  readonly attachFolderToSpace?: boolean
  readonly editedArguments?: ToolDecisionEdits
  readonly alternative?: "draft"
  readonly askedAt?: string
}

type ToolDecisionEdits = Extract<
  Extract<ToolDecision, { readonly kind: typeof TOOL_DECISION.approved }>["edits"],
  { readonly kind: typeof ARGUMENT_EDITS.edited }
>["arguments"]

const askedAtOf = (asked: DecisionAsked): string | undefined =>
  asked.kind === DECISION_ASKED.at ? asked.at : undefined

export const decisionFields = (payload: {
  readonly result: string
  readonly decision: ToolDecision
  readonly asked: DecisionAsked
}): DecisionFields => {
  const { decision } = payload
  const askedAt = askedAtOf(payload.asked)
  const grant =
    decision.grant.kind === STANDING_GRANT.standing
      ? {
          grantStanding: true,
          ...(decision.grant.list === GRANT_LIST.cardDefault
            ? {}
            : { grantList: decision.grant.list })
        }
      : {}
  return {
    result: payload.result,
    ...(decision.kind === TOOL_DECISION.unstated
      ? {}
      : { approved: decision.kind === TOOL_DECISION.approved }),
    ...grant,
    ...(decision.kind === TOOL_DECISION.approved && decision.folder === FOLDER_ATTACH.attach
      ? { attachFolderToSpace: true }
      : {}),
    ...(decision.kind === TOOL_DECISION.approved && decision.edits.kind === ARGUMENT_EDITS.edited
      ? { editedArguments: decision.edits.arguments }
      : {}),
    ...(decision.kind === TOOL_DECISION.approved && decision.as === APPROVED_AS.draft
      ? { alternative: APPROVED_AS.draft }
      : {}),
    ...(askedAt === undefined ? {} : { askedAt })
  }
}

export const cancelTarget = (payload: typeof CancelRequestSchema.Type): RunCancelTarget =>
  payload.kind === CANCEL_TARGET.run ? { runId: payload.run_id } : { sessionId: payload.session_id }

export const connectionResultText = (result: ConnectionResultText, approved: boolean): string => {
  if (result.kind === CONNECTION_RESULT.stated) return result.text
  return approved ? "connected" : "not now"
}

export const connectionDeferredText = (result: ConnectionResultText): string =>
  result.kind === CONNECTION_RESULT.stated ? result.text : ""

export const queuedMessageResponse = (message: ChatQueuedMessage): QueuedChatMessage => ({
  client_id: message.clientId,
  message: message.message,
  images: message.images.map((image) => ({
    type: "image" as const,
    media_type: image.mediaType,
    data: image.data
  })),
  enqueued_at: message.enqueuedAt,
  sent_from: sentFromWire(message.sentFrom),
  failure:
    message.failedReason === undefined
      ? { kind: QUEUED_FAILURE.none }
      : { kind: QUEUED_FAILURE.failed, reason: message.failedReason }
})

export const cardChoices = (
  fields: DecisionFields,
  registry: {
    readonly applyApprovalEdits: ApprovalEditsInput["apply"]
    readonly offersApprovalDraft: ApprovalAlternativeInput["offeredBy"]
  }
): Omit<DecisionFields, "editedArguments" | "alternative"> & {
  readonly edits?: ApprovalEditsInput
  readonly alternative?: ApprovalAlternativeInput
} => {
  const { editedArguments, alternative, ...rest } = fields
  return {
    ...rest,
    ...(editedArguments === undefined
      ? {}
      : { edits: { patch: editedArguments, apply: registry.applyApprovalEdits } }),
    ...(alternative === undefined
      ? {}
      : { alternative: { kind: alternative, offeredBy: registry.offersApprovalDraft } })
  }
}

export const sentFromField = (sentFrom: SentFrom): { readonly sentFrom?: ChatSentFrom } =>
  sentFrom.kind === SENT_FROM.surface ? { sentFrom: sentFrom.surface } : {}

export const receiptRun = (runId: string | null): (typeof ChatReceiptResponseSchema.Type)["run"] =>
  runId === null ? { kind: RECEIPT_RUN.none } : { kind: RECEIPT_RUN.run, run_id: runId }
