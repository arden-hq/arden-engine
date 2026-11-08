import type { CancelInput } from "@arden-hq/protocol/chat"
import { Effect } from "effect"
import type { ChatWriteCancelResult, ChatWriteStore } from "../persistence/chat/store.js"
import { ChatMessageError, mapWriteError, type ChatMessageFailure } from "./message-errors.js"

interface StopRunDeps {
  readonly store: Pick<ChatWriteStore["Service"], "stopEndedWork">
  readonly cancelAgent: (input: {
    readonly runId: string
  }) => Effect.Effect<void, ChatMessageFailure>
}

export const stopRun: (
  deps: StopRunDeps,
  input: CancelInput,
  active: Effect.Effect<Pick<ChatWriteCancelResult, "runId">, ChatMessageFailure>
) => Effect.Effect<{ readonly runId: string }, ChatMessageFailure> = Effect.fn(
  "ChatMessage.stopRun"
)(function* (
  deps: StopRunDeps,
  input: CancelInput,
  active: Effect.Effect<Pick<ChatWriteCancelResult, "runId">, ChatMessageFailure>
) {
  const stopped = yield* active.pipe(
    Effect.map((run) => ({ kind: "cancelled" as const, runId: run.runId })),
    Effect.catch((error) =>
      error instanceof ChatMessageError && error.reason === "not_found"
        ? Effect.succeed({ kind: "no_active" as const, notFound: error })
        : Effect.fail(error)
    )
  )
  const ended =
    stopped.kind === "no_active" || input.sessionId !== undefined
      ? yield* deps.store.stopEndedWork(input).pipe(Effect.mapError(mapWriteError))
      : { runIds: [], descendantRunIds: [] }
  for (const descendant of ended.descendantRunIds) yield* deps.cancelAgent({ runId: descendant })
  if (stopped.kind === "cancelled") return { runId: stopped.runId }
  const [runId] = ended.runIds
  if (runId === undefined) return yield* Effect.fail(stopped.notFound)
  return { runId }
})
