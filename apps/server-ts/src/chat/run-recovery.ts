import { Cause, Effect, Scope, Stream, type Semaphore } from "effect"
import { ChatWriteStore, type ChatWriteResume } from "../persistence/chat/store.js"
import { WorkStore } from "../persistence/work/store.js"
import { mapWriteError, type ChatMessageFailure } from "./message-errors.js"
import type { TaskContinuationInput } from "./run-driver.js"
import { currentIso } from "../runtime/clock.js"

const STRANDED_RUN_SWEEP_INTERVAL = "1 minute"

const resumeRun = Effect.fn("ChatMessage.resumeRun")(function* (
  runId: string,
  launch: (run: ChatWriteResume) => Effect.Effect<void>
): Effect.fn.Return<void, ChatMessageFailure, ChatWriteStore> {
  const store = yield* ChatWriteStore
  const claimed = yield* store.claimResume(runId).pipe(
    Effect.catchTag("ChatWriteError", (error) =>
      error.reason === "corrupt"
        ? store
            .fail({
              runId,
              code: "runner_error",
              message: `This run could not resume: ${error.message}`
            })
            .pipe(Effect.as(null))
        : Effect.fail(error)
    ),
    Effect.mapError(mapWriteError)
  )
  if (claimed !== null) yield* launch(claimed)
})

export const startRunRecovery = Effect.fn("ChatMessage.runRecovery")(function* (input: {
  readonly beforeResume: Effect.Effect<void>
  readonly lifecycle: Semaphore.Semaphore
  readonly launch: (run: ChatWriteResume) => Effect.Effect<void>
  readonly continueTask: (input: TaskContinuationInput) => Effect.Effect<void>
  readonly runsEnded: (runIds: ReadonlyArray<string>) => Effect.Effect<void>
  readonly ownedRunIds: () => ReadonlyArray<string>
  readonly available: () => boolean
  readonly availability: Stream.Stream<boolean>
  readonly wake: Stream.Stream<unknown>
}): Effect.fn.Return<void, never, ChatWriteStore | WorkStore | Scope.Scope> {
  const store = yield* ChatWriteStore
  const workStore = yield* WorkStore
  const serverScope = yield* Scope.Scope
  const resumeReady = input.beforeResume.pipe(
    Effect.andThen(
      input.lifecycle
        .withPermit(
          Effect.gen(function* () {
            const runIds = yield* store.listResumable().pipe(Effect.mapError(mapWriteError))
            for (const runId of runIds) {
              yield* resumeRun(runId, input.launch).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Could not resume Chat run", {
                    runId,
                    cause: Cause.pretty(cause)
                  })
                ),
                Effect.ensuring(input.runsEnded([runId]))
              )
            }
          })
        )
        .pipe(
          Effect.catchCause((cause) => Effect.logError("Could not resume ready Chat runs", cause))
        )
    )
  )
  const kickIdleTasks = (bootStamp: string) =>
    workStore.idleInChat().pipe(
      Effect.flatMap((steps) =>
        Effect.forEach(
          steps,
          (step) => input.continueTask({ itemId: step.itemId, sourceId: `boot:${bootStamp}` }),
          { discard: true }
        )
      ),
      Effect.catchCause((cause) => Effect.logError("Could not continue idle in-chat Tasks", cause))
    )
  const onArrival = input.availability.pipe(
    Stream.changes,
    Stream.filter((available) => available),
    Stream.runForEach(() =>
      Effect.sync(() => currentIso()).pipe(
        Effect.flatMap((stamp) => resumeReady.pipe(Effect.andThen(kickIdleTasks(stamp))))
      )
    )
  )
  yield* Effect.forkIn(onArrival, serverScope)
  yield* Effect.forkIn(
    input.wake.pipe(
      Stream.runForEach(() => Effect.suspend(() => (input.available() ? resumeReady : Effect.void)))
    ),
    serverScope
  )

  const sweep = input.lifecycle
    .withPermit(
      Effect.gen(function* () {
        const closed = yield* store.interruptStranded({
          ownedRunIds: input.ownedRunIds()
        })
        if (closed.length > 0) {
          yield* Effect.logWarning("Closed Chat runs left without an executor", {
            runIds: closed
          })
        }
        yield* input.runsEnded(closed)
      })
    )
    .pipe(Effect.andThen(resumeReady))
  const sweepStranded = Effect.sleep(STRANDED_RUN_SWEEP_INTERVAL).pipe(
    Effect.andThen(Effect.suspend(() => (input.available() ? sweep : Effect.void))),
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep stranded Chat runs", cause)),
    Effect.forever
  )
  yield* Effect.forkIn(sweepStranded, serverScope)
})
