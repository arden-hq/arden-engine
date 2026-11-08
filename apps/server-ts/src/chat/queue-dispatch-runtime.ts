import { Clock, Context, Effect, Fiber, Layer, Queue, type Scope, Stream } from "effect"
import { SessionLifecycleEvents } from "../persistence/sessions/events.js"
import { ChatWriteStore, type ChatQueueHead } from "../persistence/chat/store.js"
import { outboxRetryDelayMs } from "../runtime/outbox.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { ChatMessage } from "./message.js"

const FAILED_RETRY_MS = 60_000

const HOLD_MS = 15_000

export class QueueHold extends Context.Service<
  QueueHold,
  {
    readonly hold: (sessionId: string) => Effect.Effect<void>
    readonly release: (sessionId: string) => Effect.Effect<void>
    readonly snapshot: Effect.Effect<{
      readonly held: ReadonlySet<string>
      readonly nextExpiryMs: number | undefined
    }>
    readonly onChange: (wake: () => void) => Effect.Effect<void, never, Scope.Scope>
  }
>()("@arden-hq/server/chat/QueueHold") {
  static readonly layer = Layer.sync(QueueHold, () => {
    const expiries = new Map<string, number>()
    const listeners = new Set<() => void>()
    const changed = Effect.sync(() => listeners.forEach((wake) => wake()))
    return QueueHold.of({
      hold: (sessionId) =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((now) => Effect.sync(() => expiries.set(sessionId, now + HOLD_MS))),
          Effect.andThen(changed)
        ),
      release: (sessionId) =>
        Effect.suspend(() => (expiries.delete(sessionId) ? changed : Effect.void)),
      snapshot: Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          for (const [sessionId, expiresAt] of expiries) {
            if (expiresAt <= now) expiries.delete(sessionId)
          }
          const next = Math.min(...expiries.values())
          return {
            held: new Set(expiries.keys()),
            nextExpiryMs: Number.isFinite(next) ? Math.max(1, next - now) : undefined
          }
        })
      ),
      onChange: (wake) =>
        Effect.acquireRelease(
          Effect.sync(() => listeners.add(wake)),
          () => Effect.sync(() => listeners.delete(wake))
        ).pipe(Effect.asVoid)
    })
  })
}

type Outcome = "sent" | "waits" | "retry" | "failed"

const tryHead = (
  writes: ChatWriteStore["Service"],
  chat: ChatMessage["Service"],
  head: ChatQueueHead
): Effect.Effect<Outcome> => {
  const keepQueued = (reason: string) =>
    writes.failQueued({ sessionId: head.sessionId, clientId: head.clientId, reason }).pipe(
      Effect.as("failed" as const),
      Effect.catch((cause) =>
        Effect.logWarning("Could not keep a refused queued message", {
          sessionId: head.sessionId,
          clientId: head.clientId,
          cause
        }).pipe(Effect.as("retry" as const))
      )
    )
  return chat
    .send({
      sessionId: head.sessionId,
      clientId: head.clientId,
      message: head.message,
      fromQueue: true,
      announce: true,
      ...(head.images.length === 0 ? {} : { images: head.images }),
      ...(head.sentFrom === undefined ? {} : { sentFrom: head.sentFrom })
    })
    .pipe(
      Effect.as("sent" as const),
      Effect.catchTag("ChatMessageConflictError", (error) => {
        if (error.kind === "session_busy") return Effect.succeed("waits" as const)
        if (error.kind === "queue_changed") return Effect.succeed("retry" as const)
        return keepQueued(error.message)
      }),
      Effect.catchTag("ChatMessageError", (error) =>
        error.reason === "unavailable" || error.reason === "storage"
          ? Effect.succeed("retry" as const)
          : keepQueued(error.message)
      )
    )
}

const retryDelayMs = (outcomes: ReadonlyArray<Outcome>, refusals: number): number | undefined => {
  if (outcomes.includes("retry")) return outboxRetryDelayMs(refusals)
  return outcomes.includes("failed") ? FAILED_RETRY_MS : undefined
}

export const QueueDispatchRuntime: Layer.Layer<
  never,
  never,
  ChatWriteStore | ChatMessage | QueueHold | SessionLifecycleEvents
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const writes = yield* ChatWriteStore
    const chat = yield* ChatMessage
    const events = yield* SessionLifecycleEvents
    const holds = yield* QueueHold
    const lifecycle = yield* ServerLifecycle
    const signals = yield* Queue.sliding<void>(1)
    yield* writes.onEnqueue(() => {
      Queue.offerUnsafe(signals, undefined)
    })
    yield* holds.onChange(() => {
      Queue.offerUnsafe(signals, undefined)
    })
    yield* lifecycle.background(
      Effect.gen(function* () {
        const follow = yield* events.open()
        yield* follow.stream.pipe(
          Stream.filter(
            (delivery) =>
              delivery.kind === "reset" ||
              (delivery.kind === "record" && delivery.event.type === "run_settled")
          ),
          Stream.runForEach(() => Queue.offer(signals, undefined)),
          Effect.catch((cause) => Effect.logWarning("Queue dispatch lost the run feed", { cause })),
          Effect.forkScoped
        )
        let timer: Fiber.Fiber<boolean> | undefined
        let refusals = 0
        while (true) {
          const heads = yield* writes
            .dueQueueHeads()
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not read the queued messages", { cause }).pipe(
                  Effect.as(undefined)
                )
              )
            )
          const { held, nextExpiryMs } = yield* holds.snapshot
          const outcomes: ReadonlyArray<Outcome> =
            heads === undefined
              ? (["retry"] as const)
              : yield* Effect.forEach(
                  heads.filter((head) => !held.has(head.sessionId)),
                  (head) => tryHead(writes, chat, head)
                )
          refusals = outcomes.includes("retry") ? refusals + 1 : 0
          const retryDelay = retryDelayMs(outcomes, refusals)
          const retryInMs =
            retryDelay === undefined || nextExpiryMs === undefined
              ? (retryDelay ?? nextExpiryMs)
              : Math.min(retryDelay, nextExpiryMs)
          if (timer !== undefined) yield* Fiber.interrupt(timer)
          timer =
            retryInMs === undefined
              ? undefined
              : yield* Effect.sleep(retryInMs).pipe(
                  Effect.andThen(Queue.offer(signals, undefined)),
                  Effect.forkScoped
                )
          yield* Queue.take(signals)
        }
      })
    )
  })
)
