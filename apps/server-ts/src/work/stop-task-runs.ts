import { Effect } from "effect"
import type { ChatMessageShape } from "../chat/message.js"
import type { WorkStore, WorkStoreError } from "../persistence/work/store.js"

export interface StoppedTaskRun {
  readonly run_id: string
  readonly outcome: "acknowledged" | "finished" | "failed"
}

export const stopTaskRuns = Effect.fn("Work.stopTaskRuns")(function* (options: {
  readonly work: Pick<WorkStore["Service"], "activeTaskRuns">
  readonly chat: Pick<ChatMessageShape, "cancel">
  readonly itemId: string
}): Effect.fn.Return<ReadonlyArray<StoppedTaskRun>, WorkStoreError> {
  const runIds = yield* options.work.activeTaskRuns(options.itemId)
  return yield* Effect.forEach(runIds, (runId) =>
    options.chat.cancel({ runId }).pipe(
      Effect.as({ run_id: runId, outcome: "acknowledged" as const }),
      Effect.catch((error) =>
        Effect.succeed({
          run_id: runId,
          outcome:
            error._tag === "ChatMessageError" && error.reason === "not_found"
              ? ("finished" as const)
              : ("failed" as const)
        })
      )
    )
  )
})
