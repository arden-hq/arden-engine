import { Clock, Effect, Layer } from "effect"
import { Diagnostics } from "./diagnostics.js"

const TICK_MS = 250
const STALL_MS = 500

export const EventLoopMonitor: Layer.Layer<never> = Layer.effectDiscard(
  Effect.gen(function* () {
    const diagnostics = yield* Diagnostics
    const tick = Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis
      yield* Effect.sleep(TICK_MS)
      const stallMs = (yield* Clock.currentTimeMillis) - before - TICK_MS
      if (stallMs < STALL_MS) return
      yield* diagnostics.operational({
        code: "runtime.event_loop_stall",
        severity: "warning",
        cause: null,
        stallMs: Math.round(stallMs)
      })
    })
    yield* Effect.forkScoped(Effect.forever(tick))
  })
)
