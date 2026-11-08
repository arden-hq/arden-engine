import { Clock, Duration, Effect, Schedule } from "effect"

/**
 * How long one step of {@link sleepUntil} may sleep. A timer does not advance
 * while the Mac sleeps, so one long timer set for a wall time fires hours late
 * after a wake; each step re-reads the wall clock, so a deadline that passed
 * during sleep is seen within one step of waking.
 */
const WALL_CLOCK_STEP = Duration.minutes(1)

export const sleepUntil = Effect.fn("WallClock.sleepUntil")(function* (at: number) {
  while (true) {
    const left = at - (yield* Clock.currentTimeMillis)
    if (left <= 0) return
    yield* Effect.sleep(Duration.min(Duration.millis(left), WALL_CLOCK_STEP))
  }
})

export const checkRetry = Schedule.min([
  Schedule.exponential("15 seconds"),
  Schedule.spaced("10 minutes")
])
