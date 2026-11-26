import type { ChatMessageInput, ChatReceipt, ToolDecision } from "@arden-hq/protocol/chat"

export const messageInput = (
  sessionId: string,
  message: string,
  fields: Partial<ChatMessageInput> = {}
): ChatMessageInput => ({
  sessionId,
  clientId: globalThis.crypto.randomUUID(),
  message,
  images: [],
  replyTo: [],
  approvalReply: { kind: "none" },
  approvalMode: { kind: "current" },
  sentFrom: { kind: "typed" },
  capture: { kind: "none" },
  outputSchema: { kind: "free" },
  ...fields
})

export const decision = (approved: boolean): ToolDecision =>
  approved
    ? {
        kind: "approved",
        grant: { kind: "once" },
        folder: "keep",
        edits: { kind: "as_asked" },
        as: "as_asked"
      }
    : { kind: "denied", grant: { kind: "once" } }

export const decisionBody = (
  approved: boolean,
  asking: { readonly askedAt: string | undefined; readonly commandId: string | undefined }
): {
  readonly decision: ToolDecision
  readonly asked: { readonly kind: "unstated" } | { readonly kind: "at"; readonly at: string }
  readonly command: { readonly kind: "none" } | { readonly kind: "command"; readonly id: string }
} => ({
  decision: decision(approved),
  asked:
    asking.askedAt === undefined
      ? { kind: "unstated" as const }
      : { kind: "at" as const, at: asking.askedAt },
  command:
    asking.commandId === undefined
      ? { kind: "none" as const }
      : { kind: "command" as const, id: asking.commandId }
})

export const receiptRunId = (receipt: ChatReceipt): string => {
  if (receipt.run.kind !== "run") throw new Error("Chat receipt did not include a run id")
  return receipt.run.runId
}
