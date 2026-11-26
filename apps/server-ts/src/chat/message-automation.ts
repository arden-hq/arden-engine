import type { ChatSendReceipt } from "../persistence/chat/send-contracts.js"
import { Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { ChatWriteStore, type ChatWriteReceiveResult } from "../persistence/chat/store.js"
import { chatRunnerSource } from "./runner-source.js"
import { ChatMessageError, mapWriteError, type ChatMessageFailure } from "./message-errors.js"
import {
  automationRequestHash,
  makeAutomationMessage,
  type ChatAutomationStartInput,
  type ChatSendInput
} from "./message-input.js"

export type StartAutomation = (
  input: ChatAutomationStartInput
) => Effect.Effect<ChatSendReceipt, ChatMessageFailure>

export const makeStartAutomation = ({
  store,
  lifecycle,
  accepting,
  chatRunner,
  launchStarted
}: {
  readonly store: ChatWriteStore["Service"]
  readonly lifecycle: Semaphore.Semaphore
  readonly accepting: Effect.Effect<void, ChatMessageError>
  readonly chatRunner: ReturnType<typeof chatRunnerSource>
  readonly launchStarted: (
    input: Pick<ChatSendInput, "sessionId" | "clientId" | "approvalReply">,
    assistantMessageId: string,
    started: ChatWriteReceiveResult
  ) => Effect.Effect<ChatSendReceipt, ChatMessageFailure>
}): StartAutomation => {
  const startAutomation = Effect.fn("ChatMessage.startAutomation")(function* (
    input: ChatAutomationStartInput
  ) {
    if (input.prompt.trim().length === 0) {
      return yield* new ChatMessageError({
        reason: "invalid",
        message: "An Automation requires a prompt",
        sessionId: input.sessionId
      })
    }
    if (chatRunner.current() === undefined) {
      return yield* new ChatMessageError({
        reason: "unavailable",
        message: "Chat model runner is not configured"
      })
    }

    const message = yield* makeAutomationMessage(input)
    const assistantMessageId = randomUUID()
    const commit = yield* store
      .prepareReceive({
        sessionId: input.sessionId,
        clientId: input.clientId,
        requestHash: automationRequestHash(input),
        assistantMessageId,
        message,
        wake: true,
        approvalMode: "ask",
        automation: input.automation,
        automationContextMode: input.contextMode,
        automationLease: input.lease,
        ...(input.handlerItem === undefined ? {} : { handlerItem: input.handlerItem }),
        automationPrompt: input.prompt,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.modelRole === undefined ? {} : { modelRole: input.modelRole })
      })
      .pipe(Effect.mapError(mapWriteError))
    return yield* Effect.uninterruptible(
      lifecycle.withPermit(
        Effect.gen(function* () {
          yield* accepting
          const started = yield* commit.pipe(Effect.mapError(mapWriteError))
          return yield* launchStarted(input, assistantMessageId, started)
        })
      )
    )
  })
  return startAutomation
}
