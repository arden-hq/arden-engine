import { Clock, Duration, Effect, Schedule } from "effect"

const LONGEST_SLEEP_BEFORE_WALL_CLOCK_RECHECK = Duration.minutes(1)

export const sleepUntil = Effect.fn("WallClock.sleepUntil")(function* (at: number) {
  while (true) {
    const left = at - (yield* Clock.currentTimeMillis)
    if (left <= 0) return
    yield* Effect.sleep(
      Duration.min(Duration.millis(left), LONGEST_SLEEP_BEFORE_WALL_CLOCK_RECHECK)
    )
  }
})

export const checkRetry = Schedule.min([
  Schedule.exponential("15 seconds"),
  Schedule.spaced("10 minutes")
])
