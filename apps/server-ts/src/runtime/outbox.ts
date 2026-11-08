import { ladderDelayMs } from "@arden-hq/std/retry"
import { type Cause, Duration, Effect, Exit } from "effect"
import { iso } from "./clock.js"

export interface Outbox<Row, E, R> {
  readonly name: string
  readonly pending: Effect.Effect<ReadonlyArray<Row>, E, R>
  readonly deliver: (row: Row) => Effect.Effect<boolean, unknown, R>
  readonly defer: (row: Row, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R>
}

export interface OutboxPolling {
  readonly first: Duration.Duration
  readonly last: Duration.Duration
}

export const pollEverySecond: OutboxPolling = {
  first: Duration.seconds(1),
  last: Duration.seconds(1)
}

const RETRY_LADDER_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

export const outboxRetryDelayMs = (attempt: number): number =>
  ladderDelayMs(RETRY_LADDER_MS, attempt)

export const nextOutboxAttemptAt = (nowMillis: number, attempt: number): string =>
  iso(nowMillis + outboxRetryDelayMs(attempt))

export const drainOutbox = Effect.fn("Outbox.drain")(function* <Row, E, R>(
  outbox: Outbox<Row, E, R>
): Effect.fn.Return<number, E, R> {
  yield* Effect.annotateCurrentSpan("outbox", outbox.name)
  const rows = yield* outbox.pending
  let delivered = 0
  for (const row of rows) {
    const exit = yield* Effect.exit(outbox.deliver(row))
    if (Exit.isFailure(exit)) yield* outbox.defer(row, exit.cause)
    else if (exit.value) delivered += 1
  }
  return delivered
})

export const runOutbox = Effect.fn("Outbox.run")(function* <Row, E, R>(
  outbox: Outbox<Row, E, R>,
  polling: OutboxPolling
): Effect.fn.Return<never, never, R> {
  let wait = polling.first
  while (true) {
    yield* Effect.sleep(wait)
    const delivered = yield* drainOutbox(outbox).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Outbox drain failed; rows stay pending", {
          outbox: outbox.name,
          cause
        }).pipe(Effect.as(0))
      )
    )
    wait = delivered > 0 ? polling.first : Duration.min(Duration.times(wait, 2), polling.last)
  }
})
