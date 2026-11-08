import { backoffDelayMs } from "@arden-hq/std/retry"
import type { JsonValue } from "@arden-hq/protocol"
import type { McpEvent } from "@arden-hq/protocol/mcp"
import { type Cause, Context, Effect, Fiber, Option, Queue, Scope } from "effect"

import { errorMessage } from "@arden-hq/std/errors"
import type { McpLiveEvents } from "../runtime.js"
import { McpEventRequestError, type McpEventStreamEnd } from "../channel.js"
import { pollMcpEvents } from "./requests.js"
import { EVENT_ERROR_CODES, type McpEventOccurrence, type McpStreamSignal } from "./wire.js"

const REPLAY_WINDOW_MS = 60 * 60_000
const POLL_MAX_EVENTS = 100
const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 1_000
const MAX_POLL_MS = 60 * 60_000
const STREAM_ACTIVATION_MS = 90_000
const STREAM_SILENCE_MS = 75_000
const STREAM_QUEUE = 1_024
const WAIT_FOR_APP_MS = 2_000
const BACKOFF = { initialMs: 1_000, maxMs: 5 * 60_000 }
const FORBIDDEN_RETRY_MS = 15 * 60_000

export interface McpEventSubscription {
  readonly key: string
  readonly server: string
  readonly event: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

interface McpEventBatch {
  readonly occurrences: ReadonlyArray<McpEventOccurrence>
  readonly cursor: string | undefined
}

export interface McpEventSink {
  readonly cursor: (
    subscription: McpEventSubscription
  ) => Effect.Effect<string | undefined, Cause.YieldableError>
  readonly deliver: (
    subscription: McpEventSubscription,
    batch: McpEventBatch
  ) => Effect.Effect<void, Cause.YieldableError>
}

export class McpEvents extends Context.Service<
  McpEvents,
  {
    readonly follow: (
      subscriptions: ReadonlyArray<McpEventSubscription>,
      sink: McpEventSink
    ) => Effect.Effect<void>
  }
>()("@arden-hq/server/mcp/McpEvents") {}

interface SessionEnd {
  readonly healthy: boolean
  readonly forbidden: boolean
  readonly why: string
}

type StreamItem =
  | { readonly kind: "signal"; readonly signal: McpStreamSignal }
  | { readonly kind: "end"; readonly end: McpEventStreamEnd }

interface LiveEvent extends McpLiveEvents {
  readonly event: McpEvent
}

export const makeMcpEventSubscriptions = Effect.fnUntraced(function* (
  live: (server: string) => McpLiveEvents | undefined
) {
  const scope = yield* Scope.Scope
  const running = new Map<string, Fiber.Fiber<never>>()
  let sink: McpEventSink | undefined

  const currentSink = Effect.suspend(() =>
    sink === undefined ? Effect.die(new Error("MCP event sink is not set")) : Effect.succeed(sink)
  )

  const annotate = (subscription: McpEventSubscription) =>
    Effect.annotateLogs({ server: subscription.server, event: subscription.event })

  const awaitApp = Effect.fnUntraced(function* (subscription: McpEventSubscription) {
    let warned = false
    while (true) {
      const connection = live(subscription.server)
      const event = connection?.events.find((candidate) => candidate.name === subscription.event)
      if (connection !== undefined && event !== undefined) {
        return { ...connection, event } satisfies LiveEvent
      }
      if (connection !== undefined && !warned) {
        warned = true
        yield* Effect.logWarning("MCP app does not list an event an Automation waits for").pipe(
          annotate(subscription)
        )
      }
      yield* Effect.sleep(WAIT_FOR_APP_MS)
    }
  })

  const pollSession = Effect.fnUntraced(function* (
    subscription: McpEventSubscription,
    app: LiveEvent
  ) {
    const deliverTo = yield* currentSink
    let cursor = yield* deliverTo.cursor(subscription)
    let healthy = false
    while (live(subscription.server)?.client === app.client) {
      const polled = yield* Effect.tryPromise({
        try: (signal) =>
          pollMcpEvents(
            app.channel,
            {
              name: subscription.event,
              arguments: subscription.arguments,
              cursor,
              maxAgeMs: REPLAY_WINDOW_MS,
              maxEvents: POLL_MAX_EVENTS
            },
            signal
          ),
        catch: (cause) => cause
      }).pipe(Effect.result)
      if (polled._tag === "Failure") return failedSession(healthy, polled.failure)
      const result = polled.success
      healthy = true
      if (result.truncated) yield* truncatedWarning(subscription)
      if (result.events.length > 0 || result.cursor !== cursor) {
        yield* (yield* currentSink).deliver(subscription, {
          occurrences: result.events,
          cursor: result.cursor
        })
      }
      cursor = result.cursor
      if (!result.hasMore) {
        const pace = result.nextPollMs ?? DEFAULT_POLL_MS
        yield* Effect.sleep(Math.min(Math.max(pace, MIN_POLL_MS), MAX_POLL_MS))
      }
    }
    return { healthy, forbidden: false, why: "the app reconnected" } satisfies SessionEnd
  })

  const pushSession = Effect.fnUntraced(function* (
    subscription: McpEventSubscription,
    app: LiveEvent
  ) {
    const cursor = yield* (yield* currentSink).cursor(subscription)
    const queue = yield* Queue.bounded<StreamItem>(STREAM_QUEUE)
    let overflowed = false
    const offer = (item: StreamItem) => {
      if (!Queue.offerUnsafe(queue, item)) overflowed = true
    }
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        app.channel.openStream(
          {
            name: subscription.event,
            arguments: subscription.arguments,
            cursor,
            maxAgeMs: REPLAY_WINDOW_MS
          },
          {
            onSignal: (signal) => offer({ kind: "signal", signal }),
            onEnd: (end) => offer({ kind: "end", end })
          }
        )
      ),
      (stream) => Effect.sync(stream.cancel)
    )
    let active = false
    let saved = cursor
    const save = Effect.fnUntraced(function* (
      occurrences: ReadonlyArray<McpEventOccurrence>,
      next: string | undefined
    ) {
      if (occurrences.length === 0 && next === saved) return
      yield* (yield* currentSink).deliver(subscription, { occurrences, cursor: next })
      saved = next
    })
    while (true) {
      if (overflowed) return { healthy: true, forbidden: false, why: "it fell behind" }
      const next = yield* Queue.take(queue).pipe(
        Effect.timeoutOption(active ? STREAM_SILENCE_MS : STREAM_ACTIVATION_MS)
      )
      if (Option.isNone(next)) {
        return {
          healthy: active,
          forbidden: false,
          why: active ? "it went silent" : "it never became active"
        } satisfies SessionEnd
      }
      const item = next.value
      if (item.kind === "end") {
        return item.end.kind === "ended"
          ? { healthy: active, forbidden: false, why: "the app ended it" }
          : refusedSession(active, item.end.error)
      }
      const signal = item.signal
      switch (signal.kind) {
        case "active":
          active = true
          if (signal.truncated) yield* truncatedWarning(subscription)
          yield* save([], signal.cursor)
          break
        case "event":
          active = true
          yield* save([signal.occurrence], signal.cursor)
          break
        case "heartbeat":
          yield* save([], signal.cursor)
          break
        case "error":
          yield* Effect.logWarning("MCP app reported an event delivery error").pipe(
            annotate(subscription),
            Effect.annotateLogs({ code: signal.error.code, cause: signal.error.message })
          )
          break
        case "terminated":
          return refusedSession(active, signal.error)
      }
    }
  }, Effect.scoped)

  const runSubscription = Effect.fnUntraced(function* (subscription: McpEventSubscription) {
    let failures = 0
    while (true) {
      const app = yield* awaitApp(subscription)
      const session = app.event.delivery.includes("push") ? pushSession : pollSession
      const end = yield* session(subscription, app).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed<SessionEnd>({
            healthy: false,
            forbidden: false,
            why: `its events could not be saved: ${String(cause)}`
          })
        )
      )
      failures = end.healthy ? 0 : failures + 1
      if (failures > 0) {
        yield* Effect.logWarning(`MCP event subscription stopped: ${end.why}`).pipe(
          annotate(subscription)
        )
      }
      yield* Effect.sleep(end.forbidden ? FORBIDDEN_RETRY_MS : backoffDelayMs(BACKOFF, failures))
    }
  })

  const follow = Effect.fn("McpEvents.follow")(function* (
    subscriptions: ReadonlyArray<McpEventSubscription>,
    nextSink: McpEventSink
  ) {
    sink = nextSink
    const wanted = new Map(subscriptions.map((subscription) => [subscription.key, subscription]))
    for (const [key, fiber] of [...running]) {
      if (wanted.has(key)) continue
      running.delete(key)
      yield* Fiber.interrupt(fiber)
    }
    for (const [key, subscription] of wanted) {
      if (running.has(key)) continue
      running.set(key, yield* Effect.forkIn(runSubscription(subscription), scope))
    }
  })

  return McpEvents.of({ follow })
})

const truncatedWarning = (subscription: McpEventSubscription) =>
  Effect.logWarning("MCP app skipped events it could no longer replay").pipe(
    Effect.annotateLogs({ server: subscription.server, event: subscription.event })
  )

const failedSession = (healthy: boolean, cause: unknown): SessionEnd =>
  cause instanceof McpEventRequestError && cause.code !== undefined
    ? refusedSession(healthy, { code: cause.code, message: cause.message })
    : { healthy, forbidden: false, why: errorMessage(cause) }

const refusedSession = (
  healthy: boolean,
  error: { readonly code: number; readonly message: string }
): SessionEnd => ({
  healthy,
  forbidden: error.code === EVENT_ERROR_CODES.forbidden,
  why: `the app refused it (${error.code}: ${error.message})`
})
