import type { AutomationEvent } from "@arden-hq/protocol"
import { Effect, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { AutomationRuntime } from "../../automations/runtime.js"
import { availableAutomationEvents } from "../../automations/event-producers.js"
import { makeAutomationDescription } from "../../assist/automation-description.js"
import { withKeepalives } from "../../chat/events.js"
import { StructuredCompletion } from "../../models/structured-completion.js"
import { GoogleConnections } from "../../google/service.js"
import { McpConnections } from "../../mcp/service.js"
import { AutomationCatalog, type PromptWriter } from "../../persistence/automations/catalog.js"
import { LocalCaller } from "../middleware/local-only.js"
import { AutomationId } from "../../persistence/automations/model.js"
import {
  SESSION_LIFECYCLE_STREAM_ID,
  SessionLifecycleEvents,
  type SessionLifecycleDelivery
} from "../../persistence/sessions/events.js"
import { isInternalLifecycleEvent } from "../../persistence/sessions/internal-events.js"
import { ArdenApi } from "../api.js"
import {
  completionErrorToHttp,
  failStore,
  logStoreFailure,
  orNotFound,
  storeErrorToHttp
} from "../errors.js"

const promptWriter = Effect.gen(function* () {
  const writer: PromptWriter = (yield* LocalCaller) === "desktop" ? "owner" : "agent"
  return writer
})

const LastEventIdSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)

const decodeLastEventId = (value: string | undefined) =>
  value === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(LastEventIdSchema)(value).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({}))
      )

type AppDelivery =
  | Extract<SessionLifecycleDelivery, { kind: "reset" }>
  | (Extract<SessionLifecycleDelivery, { kind: "record" }> & { readonly event: AutomationEvent })

const forApp = (delivery: SessionLifecycleDelivery): delivery is AppDelivery =>
  delivery.kind === "reset" || !isInternalLifecycleEvent(delivery.event)

const lifecycleSse = (delivery: AppDelivery): Sse.Event => {
  if (delivery.kind === "reset") {
    return {
      _tag: "Event",
      id: String(delivery.cursor),
      event: "stream_reset",
      data: JSON.stringify({
        type: "stream_reset",
        session_id: SESSION_LIFECYCLE_STREAM_ID,
        seq: delivery.cursor,
        reason: delivery.reason
      })
    }
  }
  return {
    _tag: "Event",
    id: String(delivery.sequence),
    event: delivery.event.type,
    data: JSON.stringify({
      ...delivery.event,
      session_id: SESSION_LIFECYCLE_STREAM_ID,
      seq: delivery.sequence,
      timestamp: delivery.event.timestamp ?? delivery.createdAtMs,
      ...(delivery.replayed ? { replay: true } : {})
    })
  }
}

export const AutomationHandlers = HttpApiBuilder.group(
  ArdenApi,
  "automations",
  Effect.fn(function* (handlers) {
    const events = yield* SessionLifecycleEvents
    const google = yield* GoogleConnections
    const mcp = yield* McpConnections
    const completion = yield* StructuredCompletion
    const store = yield* AutomationCatalog
    const runtime = yield* AutomationRuntime
    const describe = makeAutomationDescription({ completion, store })
    return handlers
      .handle("configurationHistory", ({ params, query }) =>
        store.history({ id: params.taskId, ...query }).pipe(Effect.catch(failStore))
      )
      .handle("list", () =>
        store.list().pipe(
          Effect.map((automations) => ({ automations })),
          Effect.tapError(logStoreFailure),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("create", ({ payload }) =>
        promptWriter.pipe(
          Effect.flatMap((writer) => store.create(payload, writer)),
          Effect.catch(failStore)
        )
      )
      .handle("eventCatalog", () =>
        availableAutomationEvents(google, mcp).pipe(
          Effect.map((events) => ({ events })),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("get", ({ params }) =>
        store
          .get(AutomationId.make(params.taskId))
          .pipe(Effect.catch(failStore), Effect.flatMap(orNotFound))
      )
      .handle("description", ({ params }) =>
        describe(AutomationId.make(params.taskId)).pipe(
          Effect.flatMap(orNotFound),
          Effect.catchTags({
            AutomationStoreError: (error) => Effect.fail(storeErrorToHttp(error)),
            StructuredCompletionError: (error) => Effect.fail(completionErrorToHttp(error))
          })
        )
      )
      .handle("runs", ({ params, query }) =>
        store.runs(AutomationId.make(params.taskId), query.limit ?? 20).pipe(
          Effect.catch(failStore),
          Effect.flatMap(orNotFound),
          Effect.map((runs) => ({ runs }))
        )
      )
      .handle("toggle", ({ params }) =>
        store.toggle(AutomationId.make(params.taskId)).pipe(
          Effect.catch(failStore),
          Effect.flatMap(orNotFound),
          Effect.map((enabled) => ({ enabled }))
        )
      )
      .handle("run", ({ params }) =>
        runtime.runNow(AutomationId.make(params.taskId)).pipe(
          Effect.catch(failStore),
          Effect.flatMap((started) =>
            started
              ? Effect.succeed({ status: "started" as const })
              : Effect.fail(new HttpApiError.NotFound({}))
          )
        )
      )
      .handle("runWithEvent", ({ params }) =>
        runtime.runWithEvent(AutomationId.make(params.taskId), params.runId).pipe(
          Effect.catch(failStore),
          Effect.flatMap((started) =>
            started
              ? Effect.succeed({ status: "started" as const })
              : Effect.fail(new HttpApiError.NotFound({}))
          )
        )
      )
      .handle("reset", ({ params, payload }) =>
        store
          .resetSystemSetting(AutomationId.make(params.taskId), payload.setting)
          .pipe(Effect.catch(failStore), Effect.flatMap(orNotFound))
      )
      .handle("update", ({ params, payload }) =>
        promptWriter.pipe(
          Effect.flatMap((writer) =>
            store.update(AutomationId.make(params.taskId), payload, writer)
          ),
          Effect.catch(failStore),
          Effect.flatMap(orNotFound)
        )
      )
      .handle("delete", ({ params }) =>
        store.delete(AutomationId.make(params.taskId)).pipe(
          Effect.catch(failStore),
          Effect.flatMap(orNotFound),
          Effect.map(() => ({ status: "deleted" as const }))
        )
      )
      .handle(
        "events",
        Effect.fn("AutomationHandlers.events")(function* ({ query, request }) {
          const headerSequence = yield* decodeLastEventId(request.headers["last-event-id"])
          let afterSequence = headerSequence
          if (query.after_seq !== undefined) {
            afterSequence =
              headerSequence === undefined
                ? query.after_seq
                : Math.max(query.after_seq, headerSequence)
          }
          const opened = yield* events
            .open(afterSequence)
            .pipe(
              Effect.catchTag("SessionLifecycleEventError", () =>
                Effect.fail(new HttpApiError.InternalServerError({}))
              )
            )
          return withKeepalives(
            opened.stream.pipe(Stream.filter(forApp), Stream.map(lifecycleSse)),
            SESSION_LIFECYCLE_STREAM_ID,
            opened.initialSequence
          )
        })
      )
  })
)
