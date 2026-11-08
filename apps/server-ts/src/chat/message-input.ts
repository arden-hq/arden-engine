import type { HandlerItemRef } from "../persistence/automations/handler-item.js"
import type { JobLeaseRef } from "@arden-hq/jobs"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import type {
  ChatApprovalMode,
  ChatMessageInput,
  ChatReceipt,
  ChatUpdate,
  ConnectionArrival,
  HistoryMessage
} from "@arden-hq/protocol/chat"
import type { ModelRole } from "@arden-hq/protocol/models"
import type { Interaction } from "@arden-hq/loop"
import { DateTime, Effect, Schema } from "effect"
import { ChatUpdateSchema } from "@arden-hq/protocol/effect/chat"
import type { ChatAutomationOrigin, ChatCaptureInput } from "../persistence/chat/store.js"
import type { StoredMessageEnvelope } from "../persistence/transcript/model.js"
import {
  isWorkflowDeliveryClientId,
  workflowDeliveryClientId
} from "../persistence/chat/workflow-delivery.js"
import { DEFAULT_APPROVAL_MODE } from "@arden-hq/protocol/permissions"
import { PROMPT_CATALOG, PROMPT_TEXT } from "../prompts/catalog.js"
import { ChatMessageError } from "./message-errors.js"
import { sha256Hex } from "@arden-hq/std/hash"

export interface ChatSendInput extends Omit<ChatMessageInput, "capture"> {
  readonly wake?: boolean
  readonly deliveryId?: string
  readonly clientId: string
  readonly isMeta?: true
  readonly interaction?: Interaction
  readonly workflowDelivery?: {
    readonly workflowRef: string
    readonly attempt: number
  }
  readonly questionAnswer?: { readonly questionId: string }
  readonly connection?: ConnectionArrival
  readonly update?: ChatUpdate
  readonly modelRole?: ModelRole
  readonly modelId?: string
  readonly announce?: true
  readonly fromChat?: ChatHandoffSource
  readonly forwardedFrom?: HistoryMessage["forwarded_from"]
  readonly continuesTask?: { readonly itemId: string }
  readonly capture?: ChatCaptureInput["via"]
  readonly fromQueue?: true
}

interface ChatHandoffSource {
  readonly sessionId: string
  readonly sessionRef: string
}

export interface ChatAutomationStartInput {
  readonly handlerItem?: HandlerItemRef
  readonly lease: JobLeaseRef
  readonly sessionId: string
  readonly clientId: string
  readonly prompt: string
  readonly automation: ChatAutomationOrigin & { readonly attemptId: number }
  readonly contextMode: AutomationContextMode
  readonly modelRole?: ModelRole
  readonly modelId?: string
}

export const taskContinuation = (input: {
  readonly sessionId: string
  readonly sourceId: string
  readonly itemId: string
  readonly text: string
  readonly approvalMode?: ChatApprovalMode | undefined
}): ChatSendInput => {
  const label = input.text
    .trim()
    .replaceAll(/\s+/g, " ")
    .replace(/[\\[\]]/g, "\\$&")
  const content = [
    PROMPT_TEXT.taskAudit,
    PROMPT_CATALOG.taskContinuation.render({
      task_link: `[${label}](arden:task/${encodeURIComponent(input.itemId)})`
    }).text
  ].join("\n\n")
  return {
    sessionId: input.sessionId,
    clientId: `task:${input.itemId}:${input.sourceId}`,
    ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
    message: content,
    interaction: {
      kind: "instruction",
      from: { type: "harness", id: `task:${input.itemId}` },
      to: { type: "agent", id: input.sessionId },
      content,
      causedBy: { type: "message", id: input.sourceId }
    },
    isMeta: true,
    continuesTask: { itemId: input.itemId }
  }
}

export const onboardingKickoff = (sessionId: string): ChatSendInput => {
  const content = PROMPT_CATALOG.onboardingKickoff.render({}).text
  return {
    sessionId,
    clientId: `onboarding:${sessionId}`,
    message: content,
    interaction: {
      kind: "instruction",
      from: { type: "harness", id: "onboarding" },
      to: { type: "agent", id: sessionId },
      content
    },
    isMeta: true
  }
}

export const isNamingInput = (input: ChatSendInput): boolean => {
  if (input.isMeta === true || input.modelRole === "background" || input.modelId !== undefined) {
    return false
  }
  const hasImages = (input.images?.length ?? 0) > 0
  const text = input.message.trim()
  return !text.startsWith("/") && (text.length > 0 || hasImages)
}

const encodeUpdate = Schema.encodeEffect(Schema.toCodecJson(ChatUpdateSchema))

export const makeUserMessage = Effect.fn("ChatMessage.makeUserMessage")(function* (
  input: ChatSendInput
) {
  const createdAt = yield* DateTime.now
  const content =
    input.images === undefined || input.images.length === 0
      ? input.message
      : [
          ...(input.message.trim().length === 0
            ? []
            : [{ type: "text" as const, text: input.message }]),
          ...input.images.map((image) => ({
            type: "image" as const,
            media_type: image.mediaType,
            data: image.data
          }))
        ]
  const message: StoredMessageEnvelope = {
    message_id: input.clientId,
    role: "user",
    created_at: DateTime.formatIso(createdAt),
    client_id: input.clientId,
    ...(input.isMeta === true ? { is_meta: true } : {}),
    ...(input.interaction === undefined ? {} : { interaction: input.interaction }),
    ...(input.recipe === undefined ? {} : { recipe: input.recipe }),
    ...(input.sentFrom === undefined ? {} : { sent_from: input.sentFrom }),
    ...(input.replyTo === undefined
      ? {}
      : {
          replyTo: {
            messageId: input.replyTo.messageId,
            role: input.replyTo.role,
            content: input.replyTo.content
          }
        }),
    ...(input.questionAnswer === undefined
      ? {}
      : { question_answer: { question_id: input.questionAnswer.questionId } }),
    ...(input.connection === undefined ? {} : { connection: { ...input.connection } }),
    ...(input.update === undefined
      ? {}
      : { update: yield* encodeUpdate(input.update).pipe(Effect.orDie) }),
    ...(input.forwardedFrom === undefined
      ? {}
      : {
          forwarded_from: {
            session_id: input.forwardedFrom.session_id,
            session_ref: input.forwardedFrom.session_ref,
            message_id: input.forwardedFrom.message_id
          }
        }),
    ...(input.fromChat === undefined
      ? {}
      : {
          from_chat: {
            session_id: input.fromChat.sessionId,
            session_ref: input.fromChat.sessionRef
          }
        }),
    ...(input.workflowDelivery === undefined
      ? {}
      : {
          workflow_delivery: {
            workflow_ref: input.workflowDelivery.workflowRef,
            attempt: input.workflowDelivery.attempt
          }
        }),
    content
  }
  return message
})

export const makeAutomationMessage = Effect.fn("ChatMessage.makeAutomationMessage")(function* (
  input: ChatAutomationStartInput
) {
  const createdAt = yield* DateTime.now
  return {
    message_id: input.clientId,
    client_id: input.clientId,
    role: "user" as const,
    created_at: DateTime.formatIso(createdAt),
    content: input.prompt,
    automation: {
      task_id: input.automation.automationId,
      name: input.automation.name,
      prompt: input.prompt,
      context_mode: input.contextMode
    }
  } satisfies StoredMessageEnvelope
})

export const validateInput = Effect.fn("ChatMessage.validateInput")(function* (
  input: ChatSendInput
) {
  if (input.message.trim().length === 0 && (input.images?.length ?? 0) === 0) {
    return yield* new ChatMessageError({
      reason: "invalid",
      message: "A Chat message requires text or an image",
      sessionId: input.sessionId
    })
  }
  if (input.interaction !== undefined && input.isMeta !== true) {
    return yield* new ChatMessageError({
      reason: "invalid",
      message: "A model interaction must be server-owned",
      sessionId: input.sessionId
    })
  }
  const workflowDelivery = input.workflowDelivery
  if (workflowDelivery === undefined) {
    if (isWorkflowDeliveryClientId(input.clientId)) {
      return yield* new ChatMessageError({
        reason: "invalid",
        message: "This Chat client id is reserved for Workflow result delivery",
        sessionId: input.sessionId
      })
    }
    return
  }
  if (
    input.isMeta !== true ||
    workflowDelivery.workflowRef.trim().length === 0 ||
    !Number.isSafeInteger(workflowDelivery.attempt) ||
    workflowDelivery.attempt < 1 ||
    input.clientId !== workflowDeliveryClientId(workflowDelivery)
  ) {
    return yield* new ChatMessageError({
      reason: "invalid",
      message: "Workflow result delivery identity is invalid",
      sessionId: input.sessionId
    })
  }
})

export const requestHash = (input: ChatSendInput): string =>
  sha256Hex(
    JSON.stringify({
      message: input.message,
      images: input.images ?? [],
      modelId: input.modelId ?? null,
      modelRole: input.modelRole ?? null,
      approvalMode: input.approvalMode ?? DEFAULT_APPROVAL_MODE,
      isMeta: input.isMeta === true,
      interaction: input.interaction ?? null,
      replyTo: input.replyTo ?? null,
      ...(input.approvalReply === undefined ? {} : { approvalReply: input.approvalReply }),
      recipe: input.recipe ?? null,
      ...(input.sentFrom === undefined ? {} : { sentFrom: input.sentFrom }),
      outputSchema: input.outputSchema ?? null,
      workflowDelivery: input.workflowDelivery ?? null,
      deliveryId: input.deliveryId ?? null,
      ...(input.wake === false ? { wake: false } : {})
    })
  )

export const automationRequestHash = (input: ChatAutomationStartInput): string =>
  sha256Hex(
    JSON.stringify({
      prompt: input.prompt,
      modelId: input.modelId ?? null,
      modelRole: input.modelRole ?? null,
      automation: input.automation,
      contextMode: input.contextMode,
      ...(input.handlerItem === undefined
        ? {}
        : { handlerItem: { id: input.handlerItem.id, attempt: input.handlerItem.attempt } })
    })
  )

export const receipt = (
  input: Pick<ChatSendInput, "sessionId" | "clientId">,
  runId: string | null,
  status: ChatReceipt["status"]
): ChatReceipt => ({
  runId,
  sessionId: input.sessionId,
  status,
  clientId: input.clientId
})
