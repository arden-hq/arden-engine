import { Cause, Effect } from "effect"
import type { AnyBackfill } from "./backfill.js"
import { backfills } from "./index.js"
import { BackfillStore, BackfillStoreError } from "../../backfills/store.js"
import { makeBackfillChunks, type BackfillState } from "./store.js"
import type { PersistenceDeps } from "../deps.js"
import { pauseBetweenBatches } from "../background-pause.js"

const BACKFILL_CHUNK_ROWS = 200

const drainBackfill = Effect.fn("Backfills.drain")(function* (
  backfill: AnyBackfill,
  {
    store,
    pause
  }: {
    readonly store: ReturnType<typeof makeBackfillChunks>
    readonly pause: Effect.Effect<void, BackfillStoreError>
  }
) {
  for (;;) {
    yield* pause
    const step = yield* store.runChunk(backfill, BACKFILL_CHUNK_ROWS)
    if (step.state.finished) return step.state
    if (step.cursor === step.previousCursor)
      return yield* new BackfillStoreError({
        message: `Backfill ${backfill.name} made no progress after cursor ${String(step.cursor)}`
      })
  }
})

export const makeBackfillRuntime = (
  deps: Pick<PersistenceDeps, "writer" | "reader" | "sessionEvents">
): BackfillStore["Service"] => {
  const store = makeBackfillChunks(deps)
  const pause = store.runActive().pipe(Effect.flatMap(pauseBetweenBatches))
  const runAll = Effect.gen(function* () {
    const finished = new Set(
      (yield* store.states()).flatMap((state) => (state.finished ? [state.name] : []))
    )
    const pending = backfills.filter((backfill) => !finished.has(backfill.name))
    if (pending.length === 0) return
    for (const backfill of pending) {
      yield* Effect.logInfo("Backfill started", { backfill: backfill.name })
      yield* drainBackfill(backfill, { store, pause }).pipe(
        Effect.tap((state) =>
          Effect.logInfo("Backfill finished", {
            backfill: backfill.name,
            converted: state.converted
          })
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Backfill stopped; it resumes on the next start", {
            backfill: backfill.name,
            error: Cause.squash(cause)
          })
        )
      )
    }
  })
  const progress = Effect.fn("BackfillRuntime.progress")(function* () {
    const states = new Map<string, BackfillState>(
      (yield* store.states()).map((state) => [state.name, state])
    )
    return yield* Effect.forEach(backfills, (backfill) => {
      const state = states.get(backfill.name)
      if (state?.finished === true)
        return Effect.succeed({
          name: backfill.name,
          converted: state.converted,
          remaining: 0,
          finished: true
        })
      return store.remaining(backfill).pipe(
        Effect.map((remaining) => ({
          name: backfill.name,
          converted: state?.converted ?? 0,
          remaining,
          finished: false
        }))
      )
    })
  })
  return BackfillStore.of({
    run: runAll.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not run the data backfills", { error: Cause.squash(cause) })
      )
    ),
    progress
  })
}
