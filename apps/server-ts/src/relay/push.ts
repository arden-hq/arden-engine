import { sha256Hex } from "@arden-hq/std/hash"
import { cutText } from "@arden-hq/std/text"
import { bodyAad, fromB64url, sealQueued, toB64url, utf8 } from "@arden-hq/relay-protocol"
import { previewLine } from "@arden-hq/protocol/chat"
import { RECORD_TOLD_STATUS } from "@arden-hq/protocol"
import { MOBILE_ASK } from "@arden-hq/protocol/mobile"
import {
  NOTICE_RECORD,
  NOTICE_TIER,
  NOTIFICATION_LEVEL,
  notifyOwner,
  noticeTier,
  type NoticeRecord,
  type NoticeTier
} from "@arden-hq/protocol/notifications"
import { Duration, Effect, Queue, Schedule, Schema, type SchemaAST } from "effect"
import type { PairedDevice, RelayStoreError } from "../persistence/relay/store.js"
import type { Notice } from "../persistence/sqlite/notices.js"
import { iso } from "../runtime/clock.js"
import type { MacIdentity } from "./identity.js"
import type { Loopback } from "./ports.js"
import { isUserAutomationPurpose } from "../persistence/job-classification.js"
import { ENDING_PURPOSE } from "../persistence/runs/ending.js"
import { HomeAsks } from "./home-asks.js"

const PUSH_NOTICE_KIND = {
  approval: MOBILE_ASK.approval,
  question: MOBILE_ASK.question,
  finished: "finished"
} as const

type PushNoticeKind = (typeof PUSH_NOTICE_KIND)[keyof typeof PUSH_NOTICE_KIND]

export interface PushNotice {
  readonly key: string
  readonly kind: PushNoticeKind
  readonly title: string
  readonly body: string
  readonly sessionId: string
  readonly collapseId: string
  readonly askId: string | undefined
  readonly runId?: string
  readonly askedAt?: string
  readonly news?: PushNews
}

const PUSH_NEWS = { finished: "finished", stopped: "stopped", posted: "posted" } as const

type PushNews = (typeof PUSH_NEWS)[keyof typeof PUSH_NEWS]

const FINISHED_ALERT: Record<PushNews, string> = {
  posted: "A new message",
  stopped: "A run stopped",
  finished: "A chat finished"
}

const CATEGORY: Record<PushNoticeKind, string | undefined> = {
  approval: "arden.approval",
  question: "arden.question",
  finished: undefined
}

const fallbackAlert = (notice: PushNotice): string => {
  switch (notice.kind) {
    case PUSH_NOTICE_KIND.approval:
      return "An approval request"
    case PUSH_NOTICE_KIND.question:
      return "A question from Arden"
    case PUSH_NOTICE_KIND.finished:
      return FINISHED_ALERT[notice.news ?? PUSH_NEWS.finished]
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
        run_id: notice.runId ?? null,
        ...(notice.askedAt === undefined ? {} : { asked_at: notice.askedAt })
      })
    ),
    aad: bodyAad({ sender: input.identity.macId, receiver: input.device.dev })
  })
  const kind = CATEGORY[notice.kind]
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

const loose: SchemaAST.ParseOptions = { onExcessProperty: "ignore" }

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
  (notice.status === RECORD_TOLD_STATUS.failed ||
    notice.status === RECORD_TOLD_STATUS.posted ||
    (notice.record === NOTICE_RECORD.ending &&
      notice.status === RECORD_TOLD_STATUS.finished &&
      (notice.purpose === ENDING_PURPOSE.chat || isUserAutomationPurpose(notice.purpose))))

const newsOf = (status: Notice["status"], tier: NoticeTier | undefined): PushNews => {
  if (status === RECORD_TOLD_STATUS.posted) return PUSH_NEWS.posted
  return tier === NOTICE_TIER.needs_you ? PUSH_NEWS.stopped : PUSH_NEWS.finished
}

const unnotified = Effect.fn("Push.unnotified")(function* (state: PushState, now: number) {
  const since = iso(now - FINISHED_WINDOW_MS)
  const home = yield* read(state.loopback, "/mobile/home", HomeAsks)
  const recorded = yield* state.notices({ since, limit: RECENT })
  const asks = home.asks.map((ask): PushNotice =>
    ask.kind === MOBILE_ASK.question
      ? {
          key: `ask:question:${ask.question_id}`,
          kind: PUSH_NOTICE_KIND.question,
          title: ask.place,
          body: ask.prompt,
          sessionId: ask.session_id,
          collapseId: ask.question_id,
          askId: ask.question_id
        }
      : {
          key: `ask:approval:${sha256Hex(JSON.stringify([ask.run_id, ask.tool_id, ask.asked_at]))}`,
          kind: PUSH_NOTICE_KIND.approval,
          title: ask.place,
          body: ask.title,
          sessionId: ask.session_id,
          collapseId: sha256Hex(JSON.stringify([ask.run_id, ask.tool_id])),
          askId: ask.tool_id,
          runId: ask.run_id,
          askedAt: ask.asked_at
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
      if (
        !notifyOwner({ record, level: NOTIFICATION_LEVEL.everything, inFront: false }) ||
        !phoneTells(notice)
      )
        return []
      const tier = noticeTier(record)
      return [
        {
          key: notice.key,
          kind: PUSH_NOTICE_KIND.finished,
          title: notice.title === "" ? "Arden" : notice.title,
          body: previewLine(notice.text) ?? "Finished",
          sessionId: notice.chatSessionId,
          collapseId:
            notice.status === RECORD_TOLD_STATUS.posted ? notice.key : notice.chatSessionId,
          askId: undefined,
          news: newsOf(notice.status, tier)
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
}): Effect.Effect<never, E, never> =>
  Queue.take(input.wakes).pipe(
    Effect.andThen(input.reconcile.pipe(Effect.retry(PUSH_RETRY))),
    Effect.forever
  )
