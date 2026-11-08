import { makeJobWorker } from "@arden-hq/jobs"
import { Effect, Layer, Stream } from "effect"
import { BrowserProcedureStore } from "../../persistence/browser-procedures/store.js"
import { SessionLifecycleEvents } from "../../persistence/sessions/events.js"
import { ServerLifecycle } from "../../runtime/lifecycle.js"
import { currentMillis } from "../../runtime/clock.js"
import { BrowserProcedures } from "./service.js"

export const BrowserProcedureRuntime = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* BrowserProcedureStore
    const procedures = yield* BrowserProcedures
    const events = yield* SessionLifecycleEvents
    const lifecycle = yield* ServerLifecycle
    const worker = makeJobWorker({
      driver: store.jobs,
      now: currentMillis,
      maxAttempts: 3,
      concurrency: 1,
      leaseDurationMs: 120_000,
      execute: (job, { signal }) =>
        Effect.runPromise(procedures.learn(job.payload.runId, signal), { signal }),
      onError: (cause) =>
        Effect.runPromise(Effect.logWarning("Browser procedure learning stopped", { cause }))
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => worker.stop()))
    const reconcile = store.reconcile().pipe(
      Effect.andThen(store.enqueue()),
      Effect.tap(() => Effect.sync(() => worker.wake())),
      Effect.catch((cause) =>
        Effect.logWarning("Could not reconcile browser procedures", { cause })
      )
    )
    yield* lifecycle.background(
      Effect.gen(function* () {
        const follow = yield* events.open()
        yield* reconcile
        worker.start()
        yield* Stream.merge(
          follow.stream.pipe(
            Stream.filter(
              (event) =>
                event.kind === "reset" ||
                event.event.type === "run_settled" ||
                event.event.type === "session_blocking_work"
            )
          ),
          Stream.tick("30 seconds")
        ).pipe(Stream.runForEach(() => reconcile))
      })
    )
  })
)
