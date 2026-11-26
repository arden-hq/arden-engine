import type { RunCancelTarget } from "../persistence/chat/send-contracts.js"
import { Effect, FiberMap, Scope, Semaphore } from "effect"
import { RunQueries } from "../persistence/runs/queries.js"
import { ChatWriteStore } from "../persistence/chat/store.js"
import { TerminalSessions } from "../terminals/service.js"
import { stopRun } from "./run-stop.js"
import { makeHeldBackground } from "./held-background.js"
import {
  CHAT_MESSAGE_FAILURE,
  ChatMessageError,
  type ChatMessageFailure
} from "./message-errors.js"
import { makeFenceAndAbort } from "./message-cancel.js"

export interface Cancellation {
  readonly requestCancellation: (
    input: RunCancelTarget
  ) => Effect.Effect<{ readonly runId: string }, ChatMessageFailure>
  readonly cancelAgent: (input: {
    readonly runId: string
  }) => Effect.Effect<void, ChatMessageFailure>
  readonly stopRuns: (runIds: ReadonlyArray<string>) => Effect.Effect<void, ChatMessageFailure>
}

export const makeCancellation = ({
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
}): Cancellation => {
  const requestCancellation = (input: RunCancelTarget) =>
    stopRun({ store, cancelAgent }, input, fenceAndAbort(input))

  const fenceAndAbort = makeFenceAndAbort({
    store,
    terminals,
    runs,
    serverScope,
    fibers,
    lifecycle,
    activeRuns,
    heldBackground
  })

  const cancelAgent: (input: {
    readonly runId: string
  }) => Effect.Effect<void, ChatMessageFailure> = Effect.fn("ChatMessage.cancelAgent")(
    function* (input: { readonly runId: string }) {
      yield* requestCancellation(input).pipe(
        Effect.catch((error) =>
          error instanceof ChatMessageError && error.reason === CHAT_MESSAGE_FAILURE.not_found
            ? Effect.void
            : Effect.fail(error)
        ),
        Effect.asVoid
      )
    }
  )

  const stopRuns = Effect.fn("ChatMessage.stopRuns")(function* (runIds: ReadonlyArray<string>) {
    for (const runId of runIds) yield* cancelAgent({ runId })
    heldBackground.stop(runIds)
    terminals.stopRuns(runIds)
  })
  return { requestCancellation, cancelAgent, stopRuns }
}
