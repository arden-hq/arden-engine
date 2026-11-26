import type { RunCancelTarget } from "../persistence/chat/send-contracts.js"
import { Effect, FiberMap, Scope, Semaphore } from "effect"
import { RunQueries } from "../persistence/runs/queries.js"
import {
  CHAT_WRITE_FAILURE,
  ChatWriteError,
  ChatWriteStore,
  type ChatWriteCancelResult
} from "../persistence/chat/store.js"
import { TerminalSessions } from "../terminals/service.js"
import { makeHeldBackground, stopHeldOfEndedRuns } from "./held-background.js"
import { mapWriteError, type ChatMessageFailure } from "./message-errors.js"

export type FenceAndAbort = (
  input: RunCancelTarget
) => Effect.Effect<ChatWriteCancelResult, ChatMessageFailure>

export const makeFenceAndAbort = ({
  store,
  terminals,
  runs,
  serverScope,
  fibers,
  lifecycle,
  activeRuns,
  heldBackground
}: {
  readonly store: ChatWriteStore["Service"]
  readonly terminals: TerminalSessions["Service"]
  readonly runs: RunQueries["Service"]
  readonly serverScope: Scope.Scope
  readonly fibers: FiberMap.FiberMap<string, void, unknown>
  readonly lifecycle: Semaphore.Semaphore
  readonly activeRuns: Map<
    string,
    { readonly controller: AbortController; readonly sessionId: string }
  >
  readonly heldBackground: ReturnType<typeof makeHeldBackground>
}): FenceAndAbort => {
  const fenceAndAbort = Effect.fn("ChatMessage.fenceAndAbort")(function* (input: RunCancelTarget) {
    return yield* Effect.uninterruptible(
      lifecycle.withPermit(
        Effect.gen(function* () {
          const cancelled = yield* store.cancel(input).pipe(Effect.mapError(mapWriteError))
          terminals.stopRuns([cancelled.runId, ...cancelled.descendantRunIds])
          yield* stopHeldOfEndedRuns(heldBackground, runs, [
            cancelled.runId,
            ...cancelled.descendantRunIds
          ])
          for (const runId of [cancelled.runId, ...cancelled.descendantRunIds]) {
            activeRuns.get(runId)?.controller.abort()
            activeRuns.delete(runId)
            yield* Effect.forkIn(FiberMap.remove(fibers, runId), serverScope)
          }
          for (const runId of cancelled.descendantRunIds) {
            yield* store.cancel({ runId }).pipe(
              Effect.catch((cause) =>
                cause instanceof ChatWriteError && cause.reason === CHAT_WRITE_FAILURE.not_found
                  ? Effect.void
                  : Effect.logWarning("Descendant cancellation remains pending", {
                      runId,
                      cause
                    })
              )
            )
          }
          return cancelled
        })
      )
    )
  })
  return fenceAndAbort
}
