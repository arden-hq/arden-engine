import { Duration, Effect } from "effect"

const TIMERS_AT_ONCE_SWITCH = { on: "1" } as const
type TimersAtOnceSwitch = (typeof TIMERS_AT_ONCE_SWITCH)[keyof typeof TIMERS_AT_ONCE_SWITCH]
const isTimersAtOnce = (value: string | undefined): value is TimersAtOnceSwitch =>
  value === TIMERS_AT_ONCE_SWITCH.on
const TIMERS_AT_ONCE_LONGEST_WAIT = Duration.millis(250)

export const timerSleep = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.suspend(() =>
    Effect.sleep(
      isTimersAtOnce(process.env["ARDEN_TIMERS_AT_ONCE"])
        ? Duration.min(Duration.fromInputUnsafe(duration), TIMERS_AT_ONCE_LONGEST_WAIT)
        : duration
    )
  )
