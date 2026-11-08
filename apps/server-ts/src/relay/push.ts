import { cutText } from "@arden-hq/std/text"
import { bodyAad, fromB64url, sealQueued, toB64url, utf8 } from "@arden-hq/relay-protocol"
import { previewLine } from "@arden-hq/protocol/chat"
import { notifyOwner, noticeTier, type NoticeRecord } from "@arden-hq/protocol/notifications"
import { Duration, Effect, Queue, Schedule, Schema } from "effect"
import type { PairedDevice, RelayStoreError } from "../persistence/relay/store.js"
import type { Notice } from "../persistence/sqlite/notices.js"
import { iso } from "../runtime/clock.js"
import type { MacIdentity } from "./identity.js"
import type { Loopback } from "./ports.js"
import { isUserAutomationPurpose } from "../persistence/job-classification.js"

export interface PushNotice {
  readonly key: string
  readonly kind: "approval" | "question" | "finished"
  readonly title: string
  readonly body: string
  readonly sessionId: string
  readonly askId: string | undefined
  readonly runId?: string
  readonly attention?: boolean
}

const category = (kind: PushNotice["kind"]): string | undefined => {
  switch (kind) {
    case "approval":
      return "arden.approval"
    case "question":
      return "arden.question"
    case "finished":
      return undefined
  }
}

const fallbackAlert = (notice: PushNotice): string => {
  switch (notice.kind) {
    case "approval":
      return "An approval request"
    case "question":
      return "A question from Arden"
    case "finished":
      return notice.attention === true ? "A run stopped" : "A chat finished"
  }
}

export const pushPayload = (input: {
  readonly identity: MacIdentity
  readonly device: PairedDevice
  readonly notice: PushNotice
}): { readonly payload: Uint8Array; readonly category: string | undefined } => {
  const { notice } = input
  const sealed = sealQueued({
    phoneStatic: input.identity.x,
    macStaticPublic: fromB64url(input.device.xPub),
    plaintext: utf8(
      JSON.stringify({
        kind: notice.kind,
        title: cutText(notice.title, 120),
        body: cutText(notice.body, 600),
        session_id: notice.sessionId,
        ask_id: notice.askId ?? null,
        run_id: notice.runId ?? null
      })
    ),
    aad: bodyAad({ sender: input.identity.macId, receiver: input.device.dev })
  })
  const kind = category(notice.kind)
  const aps = {
    alert: {
      title: "Arden",
      body: fallbackAlert(notice)
    },
    "mutable-content": 1,
    sound: "default",
    ...(kind === undefined ? {} : { category: kind }),
    "thread-id": notice.sessionId
  }
  return { payload: utf8(JSON.stringify({ aps, e: toB64url(sealed) })), category: kind }
}

class PushReadError extends Schema.TaggedError<PushReadError>()("PushReadError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

const FINISHED_WINDOW_MS = 60 * 60_000

const RECENT = 50

const Asks = Schema.Struct({
  asks: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("question"),
        question_id: Schema.String,
        session_id: Schema.String,
        place: Schema.String,
        prompt: Schema.String
      }),
      Schema.Struct({
        kind: Schema.Literal("approval"),
        tool_id: Schema.String,
        run_id: Schema.String,
        session_id: Schema.String,
        place: Schema.String,
        title: Schema.String
      })
    ])
  )
})

const loose = { onExcessProperty: "ignore" } as const

export interface PushState {
  readonly loopback: Loopback
  readonly notices: (query: {
    readonly since: string
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<Notice>, RelayStoreError>
  readonly notified: (
    keys: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlySet<string>, RelayStoreError>
}

const phoneTells = (notice: Notice): notice is Notice & { readonly chatSessionId: string } =>
  notice.chatSessionId !== null &&
  (notice.status === "failed" ||
    (notice.record === "ending" &&
      notice.status === "finished" &&
      (notice.purpose === "chat" || isUserAutomationPurpose(notice.purpose))))

const unnotified = Effect.fn("Push.unnotified")(function* (state: PushState, now: number) {
  const since = iso(now - FINISHED_WINDOW_MS)
  const home = yield* read(state.loopback, "/mobile/home", Asks)
  const recorded = yield* state.notices({ since, limit: RECENT })
  const asks = home.asks.map((ask): PushNotice =>
    ask.kind === "question"
      ? {
          key: `ask:question:${ask.question_id}`,
          kind: "question",
          title: ask.place,
          body: ask.prompt,
          sessionId: ask.session_id,
          askId: ask.question_id
        }
      : {
          key: `ask:approval:${ask.run_id}:${ask.tool_id}`,
          kind: "approval",
          title: ask.place,
          body: ask.title,
          sessionId: ask.session_id,
          askId: ask.tool_id,
          runId: ask.run_id
        }
  )
  const candidates = [
    ...asks,
    ...recorded.flatMap((notice): ReadonlyArray<PushNotice> => {
      const record: NoticeRecord = {
        kind: notice.record,
        key: notice.key,
        status: notice.status,
        shown: notice.shown,
        unread: notice.unread
      }
      if (!notifyOwner({ record, level: "everything", inFront: false }) || !phoneTells(notice))
        return []
      const tier = noticeTier(record)
      return [
        {
          key: notice.key,
          kind: "finished",
          title: notice.title === "" ? "Arden" : notice.title,
          body: previewLine(notice.text) ?? "Finished",
          sessionId: notice.chatSessionId,
          askId: undefined,
          attention: tier === "needs_you"
        }
      ]
    })
  ]
  const done = yield* state.notified(candidates.map((notice) => notice.key))
  return candidates.filter((notice) => !done.has(notice.key))
})

export interface PushRoute {
  readonly devices: ReadonlyArray<string>
  readonly send: (notice: PushNotice, dev: string) => boolean
}

export interface PushDelivery {
  readonly state: PushState
  readonly seeded: () => Effect.Effect<boolean, RelayStoreError>
  readonly seed: (keys: ReadonlyArray<string>) => Effect.Effect<void, RelayStoreError>
  readonly claim: (key: string) => Effect.Effect<boolean, RelayStoreError>
  readonly release: (key: string) => Effect.Effect<void, RelayStoreError>
  readonly present: () => Effect.Effect<boolean, RelayStoreError>
  readonly route: () => Effect.Effect<PushRoute | undefined, RelayStoreError>
}

export const deliverPushes = Effect.fn("Push.deliver")(function* (
  delivery: PushDelivery,
  now: number
) {
  const route = yield* delivery.route()
  if (route === undefined) return
  if (!(yield* delivery.seeded())) {
    const waiting = yield* unnotified(delivery.state, now)
    yield* delivery.seed(waiting.map((notice) => notice.key))
    return
  }
  const notices = yield* unnotified(delivery.state, now)
  if (notices.length === 0 || (yield* delivery.present())) return
  for (const notice of notices) {
    let everyPhone = true
    for (const dev of route.devices) {
      const key = `${notice.key}|${dev}`
      if (!(yield* delivery.claim(key))) continue
      const accepted = yield* Effect.try({
        try: () => route.send(notice, dev),
        catch: (cause) => cause
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Relay push failed", { key: notice.key, cause }).pipe(Effect.as(false))
        )
      )
      if (!accepted) {
        everyPhone = false
        yield* delivery.release(key)
      }
    }
    if (everyPhone) yield* delivery.claim(notice.key)
  }
})

const read = <A>(loopback: Loopback, path: string, schema: Schema.Decoder<A>) =>
  Effect.tryPromise({
    try: () => loopback.request({ method: "GET", path }),
    catch: (cause) => new PushReadError({ message: `Could not read ${path}`, cause })
  }).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Schema.decodeUnknownEffect(schema)(response.body, loose).pipe(
            Effect.mapError(
              (cause) => new PushReadError({ message: `${path} did not decode`, cause })
            )
          )
        : Effect.fail(
            new PushReadError({
              message: `${path} answered ${response.status}`,
              cause: response.body
            })
          )
    )
  )

export const PUSH_RETRY = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(5)))
  )
)

export const runPushes = <E>(input: {
  readonly wakes: Queue.Dequeue<void>
  readonly reconcile: Effect.Effect<void, E>
}) =>
  Queue.take(input.wakes).pipe(
    Effect.andThen(input.reconcile.pipe(Effect.retry(PUSH_RETRY))),
    Effect.forever
  )
