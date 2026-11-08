import { Cause, Effect, Layer, Stream } from "effect"

import { ManagedOutputs } from "../artifacts/managed-output/managed-output.js"
import { ChatMessage } from "../chat/message.js"
import { ScriptResults } from "../persistence/scripts/results.js"
import { ScriptStore, type ScriptRecord } from "../persistence/scripts/store.js"
import { retryScriptResults } from "./delivery.js"
import { WorkflowHost } from "./host.js"
import { ScriptRunner } from "./script-runner.js"
import { SessionLifecycleEvents } from "../persistence/sessions/events.js"

const resumeScripts = Effect.fn("ScriptBoot.resume")(function* () {
  const store = yield* ScriptStore
  const runner = yield* ScriptRunner
  const message = yield* ChatMessage
  const workflowHost = yield* WorkflowHost
  const resumeOne = (record: ScriptRecord) =>
    Effect.gen(function* () {
      if (runner.owns(record.ref)) return
      const run = yield* message.detachedRun({
        sessionId: record.originSessionId,
        runId: record.originRunId
      })
      yield* runner.resume({ record, binding: { run, host: workflowHost.forRun(run) } })
    }).pipe(
      Effect.catchTag("ChatMessageError", (error) =>
        error.reason === "unavailable" || error.reason === "storage"
          ? Effect.logWarning("Script recovery is waiting for its runtime", {
              ref: record.ref,
              reason: error.reason
            })
          : Effect.fail(error)
      ),
      Effect.catchTag("ScriptStoreError", (error) =>
        error.reason === "storage" || error.reason === "conflict"
          ? Effect.logWarning("Script recovery will retry", {
              ref: record.ref,
              reason: error.reason
            })
          : Effect.fail(error)
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Could not continue a script after restart", {
              ref: record.ref,
              error: Cause.squash(cause)
            }).pipe(
              Effect.andThen(
                store.settle({
                  ref: record.ref,
                  attempt: record.attempt,
                  settlement: {
                    status: "failed",
                    value: null,
                    error: {
                      code: "interrupted",
                      message: "Arden restarted and could not continue the script",
                      retryable: true,
                      recovery_action: "retry"
                    },
                    sourceRefs: []
                  }
                })
              ),
              Effect.catchCause(() => Effect.void)
            )
      )
    )
  yield* Effect.forEach(yield* store.running(), resumeOne, { discard: true })
})

const retryResults = Effect.fn("ScriptBoot.results")(function* () {
  const results = yield* ScriptResults
  const message = yield* ChatMessage
  const outputs = yield* ManagedOutputs
  return yield* retryScriptResults({
    results,
    limit: 25,
    send: (request) => Effect.runPromise(message.send(request)),
    outputs
  })
})

export const ScriptBoot = Layer.effectDiscard(
  Effect.gen(function* () {
    const message = yield* ChatMessage
    const lifecycle = yield* SessionLifecycleEvents
    const changes = yield* lifecycle.open().pipe(Effect.orDie)
    yield* Effect.forkScoped(
      Stream.mergeAll(
        [
          message.runnerAvailability.pipe(
            Stream.filter((available) => available),
            Stream.map(() => undefined)
          ),
          Stream.tick("1 minute"),
          changes.stream.pipe(
            Stream.filter(
              (change) => change.kind === "record" && change.event.type === "session_activity"
            ),
            Stream.map(() => undefined),
            Stream.orDie
          )
        ],
        { concurrency: "unbounded" }
      ).pipe(
        Stream.runForEach(() =>
          resumeScripts().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not reconcile running scripts", cause)
            )
          )
        )
      )
    )
    yield* Effect.forkScoped(retryResults())
  })
)
