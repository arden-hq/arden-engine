import {
  ANSWER_SHAPE,
  APPROVAL_REPLY,
  CHAT_CAPTURE,
  REQUESTED_MODE,
  SENT_FROM,
  type ChatApprovalMode,
  type ChatImageInput,
  type ChatMessageInput
} from "@arden-hq/protocol/chat"

export type OutputSchema = Extract<
  ChatMessageInput["outputSchema"],
  { readonly kind: typeof ANSWER_SHAPE.schema }
>["schema"]

export const runMessage = (input: {
  readonly sessionId: string
  readonly prompt: string
  readonly images: ReadonlyArray<ChatImageInput>
  readonly outputSchema: OutputSchema | undefined
  readonly approvalMode: ChatApprovalMode
}): ChatMessageInput => ({
  sessionId: input.sessionId,
  clientId: globalThis.crypto.randomUUID(),
  message: input.prompt,
  images: input.images,
  replyTo: [],
  approvalReply: { kind: APPROVAL_REPLY.none },
  approvalMode: { kind: REQUESTED_MODE.mode, mode: input.approvalMode },
  sentFrom: { kind: SENT_FROM.typed },
  capture: { kind: CHAT_CAPTURE.none },
  outputSchema:
    input.outputSchema === undefined
      ? { kind: ANSWER_SHAPE.free }
      : { kind: ANSWER_SHAPE.schema, schema: input.outputSchema }
})
