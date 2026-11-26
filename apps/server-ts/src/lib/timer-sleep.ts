import { Duration, Effect } from "effect"

const TIMERS_AT_ONCE_LONGEST_WAIT = Duration.millis(250)

export const timerSleep = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.suspend(() =>
    Effect.sleep(
      process.env["ARDEN_TIMERS_AT_ONCE"] === "1"
        ? Duration.min(Duration.fromInputUnsafe(duration), TIMERS_AT_ONCE_LONGEST_WAIT)
        : duration
    )
  )
