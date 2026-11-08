import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { ManagedOutputs } from "../../artifacts/managed-output/managed-output.js"
import { ChatMessage } from "../../chat/message.js"
import { ScriptJournal } from "../../persistence/scripts/journal.js"
import { ScriptResults } from "../../persistence/scripts/results.js"
import { ScriptStore, ScriptStoreError } from "../../persistence/scripts/store.js"
import { SessionQueries } from "../../persistence/sessions/queries.js"
import {
  ScriptAccessError,
  readOwnedScript,
  scriptDetail,
  scriptSummary
} from "../../workflows/access.js"
import { drainScriptResults } from "../../workflows/delivery.js"
import { WorkflowHost } from "../../workflows/host.js"
import { ScriptRunner } from "../../workflows/script-runner.js"
import { ArdenApi } from "../api.js"
import { type StoreConflict, StoreInvalid, storeErrorToHttp } from "../errors.js"

type ScriptHttpError =
  | HttpApiError.NotFound
  | StoreConflict
  | StoreInvalid
  | HttpApiError.InternalServerError

const storeError = (error: ScriptStoreError): ScriptHttpError => {
  if (error.reason === "unsafe_retry") return new StoreInvalid({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

const accessError = (error: unknown): ScriptHttpError => {
  if (error instanceof ScriptStoreError) return storeError(error)
  if (error instanceof ScriptAccessError) return new HttpApiError.NotFound({})
  return new HttpApiError.InternalServerError({})
}

export const ScriptHandlers = HttpApiBuilder.group(
  ArdenApi,
  "scripts",
  Effect.fn("ScriptHandlers")(function* (handlers) {
    const store = yield* ScriptStore
    const journal = yield* ScriptJournal
    const results = yield* ScriptResults
    const runner = yield* ScriptRunner
    const sessions = yield* SessionQueries
    const message = yield* ChatMessage
    const workflowHost = yield* WorkflowHost
    const outputs = yield* ManagedOutputs
    const drain = drainScriptResults({
      results,
      limit: 100,
      send: (request) => Effect.runPromise(message.send(request)),
      outputs
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A script result is waiting to be sent", cause)
      )
    )
    const owned = (ref: string, sessionId: string) =>
      readOwnedScript({ store, sessions, ref, sessionId }).pipe(Effect.mapError(accessError))

    return handlers
      .handle(
        "get",
        Effect.fn("ScriptHandlers.get")(function* ({ params, query }) {
          const record = yield* owned(params.workflowRef, query.session_id)
          return yield* scriptDetail(journal, record).pipe(
            Effect.mapError(() => new HttpApiError.InternalServerError({}))
          )
        })
      )
      .handle(
        "retry",
        Effect.fn("ScriptHandlers.retry")(function* ({ params, payload, query }) {
          const record = yield* owned(params.workflowRef, query.session_id)
          const run = yield* message
            .detachedRun({ sessionId: record.originSessionId, runId: record.originRunId })
            .pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({})))
          const host = yield* Effect.try({
            try: () => workflowHost.forRun(run),
            catch: () => new HttpApiError.ServiceUnavailable({})
          })
          const retried = yield* runner
            .retry({
              ref: record.ref,
              expectedVersion: payload.expected_version,
              binding: { run, host }
            })
            .pipe(Effect.mapError(storeError))
          return scriptSummary(retried)
        })
      )
      .handle(
        "cancel",
        Effect.fn("ScriptHandlers.cancel")(function* ({ params, query }) {
          const record = yield* owned(params.workflowRef, query.session_id)
          const cancelled = yield* runner
            .cancel({
              ref: record.ref,
              cancelAgent: (input) =>
                Effect.runPromise(message.cancel({ runId: input.runId }).pipe(Effect.asVoid))
            })
            .pipe(Effect.mapError(storeError))
          yield* drain
          return scriptSummary(cancelled)
        })
      )
  })
)
