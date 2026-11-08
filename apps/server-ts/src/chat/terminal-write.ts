import { Effect, Result, Schedule } from "effect"
import { ChatWriteError, type ChatWriteFailure } from "../persistence/chat/store.js"

const TERMINAL_WRITE_RETRIES = 3
const TERMINAL_WRITE_BACKOFF = "50 millis"

export const isRunAlreadyTerminal = (failure: ChatWriteFailure): boolean =>
  failure instanceof ChatWriteError && failure.reason === "terminal"

export const persistRunTerminal = <A>(
  write: Effect.Effect<A, ChatWriteFailure>
): Effect.Effect<Result.Result<A, ChatWriteFailure>> =>
  Effect.uninterruptible(
    write.pipe(
      Effect.retry({
        times: TERMINAL_WRITE_RETRIES,
        schedule: Schedule.exponential(TERMINAL_WRITE_BACKOFF),
        while: (failure: ChatWriteFailure) =>
          failure instanceof ChatWriteError && failure.reason === "storage"
      }),
      Effect.result
    )
  )
