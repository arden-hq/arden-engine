import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { WorkStore } from "../persistence/work/store.js"
import { ChatWriteStore, type ChatWriteReceiveResult } from "../persistence/chat/store.js"
import { chatRunnerSource } from "./runner-source.js"
import { ChatMessageError, mapWriteError, type ChatMessageFailure } from "./message-errors.js"
import {
  makeInputMessage,
  requestHash,
  validateInput,
  type ChatSendInput
} from "./message-input.js"
import type { makeHelperJobs } from "./helper-jobs.js"

interface PreparedSend {
  readonly input: ChatSendInput
  readonly assistantMessageId: string
  readonly started: ChatWriteReceiveResult
}

export type Prepare = (
  input: ChatSendInput,
  admittedWith?: ReadonlyArray<string>
) => Effect.Effect<Effect.Effect<PreparedSend, ChatMessageFailure>, ChatMessageFailure>

export const makePrepare = ({
  store,
  workStore,
  chatRunner,
  scheduleNaming
}: {
  readonly store: ChatWriteStore["Service"]
  readonly workStore: WorkStore["Service"]
  readonly chatRunner: ReturnType<typeof chatRunnerSource>
  readonly scheduleNaming: Effect.Success<ReturnType<typeof makeHelperJobs>>["scheduleNaming"]
}): Prepare => {
  const prepare = Effect.fn("ChatMessage.prepare")(function* (
    input: ChatSendInput,
    admittedWith?: ReadonlyArray<string>
  ) {
    yield* validateInput(input)
    if (chatRunner.current() === undefined) {
      return yield* new ChatMessageError({
        reason: "unavailable",
        message: "Chat model runner is not configured"
      })
    }
    yield* workStore.stopSpent({ sessionId: input.sessionId }).pipe(
      Effect.mapError(
        (cause) =>
          new ChatMessageError({
            reason: "storage",
            message: "Could not check the chat's Task budget",
            sessionId: input.sessionId,
            cause
          })
      )
    )
    const message = yield* makeInputMessage(input)
    const assistantMessageId = randomUUID()
    const commit = yield* store
      .prepareReceive({
        sessionId: input.sessionId,
        clientId: input.clientId,
        requestHash: requestHash(input),
        assistantMessageId,
        message,
        ...(input.approvalReply === undefined ? {} : { approvalReply: input.approvalReply }),
        wake: input.wake ?? true,
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
        ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
        ...(admittedWith === undefined ? {} : { admittedWith }),
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.modelRole === undefined ? {} : { modelRole: input.modelRole }),
        ...(input.announce === undefined ? {} : { announce: true }),
        ...(input.fromQueue === undefined ? {} : { fromQueue: true }),
        ...(input.opensOnboarding === undefined ? {} : { opensOnboarding: true }),
        ...(input.continuesTask === undefined ? {} : { continuesTask: input.continuesTask }),
        ...(input.capture === undefined
          ? {}
          : {
              capture: {
                via: input.capture,
                note: input.message,
                screenshot: (input.images?.length ?? 0) > 0
              }
            })
      })
      .pipe(Effect.mapError(mapWriteError))
    return commit.pipe(
      Effect.mapError(mapWriteError),
      Effect.tap(() => scheduleNaming(input)),
      Effect.map((started) => ({ input, assistantMessageId, started }))
    )
  })
  return prepare
}
