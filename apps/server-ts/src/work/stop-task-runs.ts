import { Effect } from "effect"
import { CHAT_MESSAGE_FAILURE, ChatMessageError } from "../chat/message-errors.js"
import type { ChatMessageShape } from "../chat/message-shape.js"
import type { WorkStore, WorkStoreError } from "../persistence/work/store.js"

export const STOPPED_RUN_OUTCOME = {
  acknowledged: "acknowledged",
  finished: "finished",
  failed: "failed"
} as const

export interface StoppedTaskRun {
  readonly run_id: string
  readonly outcome: (typeof STOPPED_RUN_OUTCOME)[keyof typeof STOPPED_RUN_OUTCOME]
}

export const stopTaskRuns = Effect.fn("Work.stopTaskRuns")(function* (options: {
  readonly work: Pick<WorkStore["Service"], "activeTaskRuns">
  readonly chat: Pick<ChatMessageShape, "cancel">
  readonly itemId: string
}): Effect.fn.Return<ReadonlyArray<StoppedTaskRun>, WorkStoreError> {
  const runIds = yield* options.work.activeTaskRuns(options.itemId)
  return yield* Effect.forEach(runIds, (runId) =>
    options.chat.cancel({ runId }).pipe(
      Effect.as({ run_id: runId, outcome: STOPPED_RUN_OUTCOME.acknowledged }),
      Effect.catch((error) =>
        Effect.succeed({
          run_id: runId,
          outcome:
            error instanceof ChatMessageError && error.reason === CHAT_MESSAGE_FAILURE.not_found
              ? STOPPED_RUN_OUTCOME.finished
              : STOPPED_RUN_OUTCOME.failed
        })
      )
    )
  )
})
