import { Duration, Effect } from "effect"

const AT_ONCE = Duration.millis(250)

/** The wait of a job that runs on a timer: before its first run and between
 * runs. Every such job waits through this, so one test can make them all run
 * at once: with ARDEN_TIMERS_AT_ONCE=1 a wait lasts a quarter second at most.
 * `test/sql-scans/route-sweep.test.ts` sets it, and the scan check then sees
 * the queries of jobs that would start minutes or an hour after launch.
 * `test/timer-jobs.test.ts` fails when a timer loop sleeps another way. */
export const timerSleep = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.suspend(() =>
    Effect.sleep(
      process.env["ARDEN_TIMERS_AT_ONCE"] === "1"
        ? Duration.min(Duration.fromInputUnsafe(duration), AT_ONCE)
        : duration
    )
  )
