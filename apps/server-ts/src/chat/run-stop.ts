import type { RunCancelTarget } from "../persistence/chat/send-contracts.js"
import { Effect } from "effect"
import type { ChatWriteCancelResult, ChatWriteStore } from "../persistence/chat/store.js"
import {
  CHAT_MESSAGE_FAILURE,
  ChatMessageError,
  mapWriteError,
  type ChatMessageFailure
} from "./message-errors.js"

const STOP_RESULT = { cancelled: "cancelled", noActive: "no_active" } as const

type StopResult =
  | { readonly kind: typeof STOP_RESULT.cancelled; readonly runId: string }
  | { readonly kind: typeof STOP_RESULT.noActive; readonly notFound: ChatMessageError }

interface StopRunDeps {
  readonly store: Pick<ChatWriteStore["Service"], "stopEndedWork">
  readonly cancelAgent: (input: {
    readonly runId: string
  }) => Effect.Effect<void, ChatMessageFailure>
}

export const stopRun: (
  deps: StopRunDeps,
  input: RunCancelTarget,
  active: Effect.Effect<Pick<ChatWriteCancelResult, "runId">, ChatMessageFailure>
) => Effect.Effect<{ readonly runId: string }, ChatMessageFailure> = Effect.fn(
  "ChatMessage.stopRun"
)(function* (
  deps: StopRunDeps,
  input: RunCancelTarget,
  active: Effect.Effect<Pick<ChatWriteCancelResult, "runId">, ChatMessageFailure>
) {
  const stopped: StopResult = yield* active.pipe(
    Effect.map((run) => ({ kind: STOP_RESULT.cancelled, runId: run.runId })),
    Effect.catch((error) =>
      error instanceof ChatMessageError && error.reason === CHAT_MESSAGE_FAILURE.not_found
        ? Effect.succeed({ kind: STOP_RESULT.noActive, notFound: error })
        : Effect.fail(error)
    )
  )
  const ended =
    stopped.kind === STOP_RESULT.noActive || input.sessionId !== undefined
      ? yield* deps.store.stopEndedWork(input).pipe(Effect.mapError(mapWriteError))
      : { runIds: [], descendantRunIds: [] }
  for (const descendant of ended.descendantRunIds) yield* deps.cancelAgent({ runId: descendant })
  if (stopped.kind === STOP_RESULT.cancelled) return { runId: stopped.runId }
  const [runId] = ended.runIds
  if (runId === undefined) return yield* Effect.fail(stopped.notFound)
  return { runId }
})
