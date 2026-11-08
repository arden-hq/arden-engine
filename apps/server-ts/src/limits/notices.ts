import { Clock, Effect, Layer, Queue, Stream } from "effect"
import { hasPlanCredits } from "@arden-hq/protocol/runs"
import { checkRetry, sleepUntil } from "../lib/wall-clock.js"
import { nextPlanReset, planLimitNotice } from "../models/plan-limits.js"
import { ModelProviderService, type ModelRoute } from "../models/provider.js"
import { LimitSettingsStore } from "../persistence/settings/store.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"

export const PlanLimitNotices = Layer.effectDiscard(
  Effect.gen(function* () {
    const models = yield* ModelProviderService
    const limits = yield* LimitSettingsStore
    const lifecycle = yield* ServerLifecycle
    const asked = yield* Queue.sliding<void>(1)
    const ask = Queue.offer(asked, undefined)
    const check = Effect.gen(function* () {
      const reading = models.current()?.planLimits?.latest()
      if (reading === undefined) return undefined
      const settings = yield* limits.settings()
      const now = yield* Clock.currentTimeMillis
      if (hasPlanCredits(reading.credits)) yield* limits.recheckPausedRuns()
      yield* limits.recordNotice(planLimitNotice(reading, settings, now))
      return nextPlanReset(reading, now)
    }).pipe(
      Effect.sandbox,
      Effect.tapError((cause) =>
        Effect.logWarning("Could not update the plan limit notice; trying again", cause)
      ),
      Effect.retry(checkRetry)
    )
    const watch = Effect.gen(function* () {
      const resetAt = yield* check
      if (resetAt === undefined) return yield* Queue.take(asked)
      yield* Effect.raceFirst(Queue.take(asked), sleepUntil(resetAt))
    })
    yield* lifecycle.background(Effect.forever(watch))
    yield* lifecycle.background(limits.changes.pipe(Stream.runForEach(() => ask)))
    yield* lifecycle.background(
      models.changes.pipe(
        Stream.switchMap(readings),
        Stream.runForEach(() => ask)
      )
    )
  })
)

const readings = (route: ModelRoute | undefined): Stream.Stream<void> =>
  Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        Queue.offerUnsafe(queue, undefined)
        return route?.planLimits?.onReading(() => Queue.offerUnsafe(queue, undefined))
      }),
      (stop) => Effect.sync(() => stop?.())
    )
  )
