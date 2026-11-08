import { decodeSseFrameStream } from "@arden-hq/protocol"
import { sleep } from "@arden-hq/std/sleep"
import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import type { RelayPairOffer, RelaySettingsPatch, RelayStatus } from "@arden-hq/protocol/relay"
import { Clock, Context, DateTime, Effect, Layer, Queue, Schedule, Schema, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { hostname } from "node:os"
import type { PowerHost } from "../config/options.js"
import type { CredentialVault } from "../credentials/vault.js"
import type { LocalAccess } from "../http/middleware/local-only.js"
import { effectiveRelayUrl, RelayStore, type RelayStoreError } from "../persistence/relay/store.js"
import { SessionLifecycleEvents } from "../persistence/sessions/events.js"
import { RelayConnector } from "./connector.js"
import { PUSH_RETRY, deliverPushes, pushPayload, runPushes, type PushRoute } from "./push.js"
import { loadMacIdentity, type MacIdentity } from "./identity.js"
import type { CommandLog, DeviceRegistry, Loopback, RelayLog } from "./ports.js"
import { errorMessage } from "@arden-hq/std/errors"
import { currentMillis, iso } from "../runtime/clock.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"

export class RelayServiceError extends Schema.TaggedError<RelayServiceError>()(
  "RelayServiceError",
  {
    reason: Schema.Literals(["unavailable", "not_found"]),
    message: Schema.String
  }
) {}

export class RelayService extends Context.Service<
  RelayService,
  {
    readonly status: () => Effect.Effect<RelayStatus, RelayStoreError>
    readonly pair: () => Effect.Effect<RelayPairOffer, RelayServiceError | RelayStoreError>
    readonly decide: (input: {
      readonly dev: string
      readonly allow: boolean
    }) => Effect.Effect<RelayStatus, RelayServiceError | RelayStoreError>
    readonly remove: (
      dev: string
    ) => Effect.Effect<RelayStatus, RelayServiceError | RelayStoreError>
    readonly updateSettings: (
      patch: RelaySettingsPatch
    ) => Effect.Effect<RelayStatus, RelayStoreError>
  }
>()("@arden-hq/server/relay/RelayService") {}

const TICK = "15 seconds"

const PUSH_WAKES: ReadonlySet<string> = new Set([
  "approval_waiting",
  "question_changed",
  "run_settled",
  "session_activity",
  "automation_finished",
  "record_told"
])
const COMMAND_RETENTION_DAYS = 7
const PAIRING_WINDOW_MS = 10 * 60_000
const CONNECT_WAIT_MS = 5_000

export interface RelayLayerOptions {
  readonly vault: CredentialVault | undefined
  readonly localAccess: LocalAccess | undefined
  readonly power: PowerHost | undefined
}

export const relayLayer = (
  options: RelayLayerOptions
): Layer.Layer<RelayService, never, RelayStore | SessionLifecycleEvents | HttpServer.HttpServer> =>
  Layer.effect(
    RelayService,
    Effect.gen(function* () {
      const store = yield* RelayStore
      const sessionEvents = yield* SessionLifecycleEvents
      const lifecycle = yield* ServerLifecycle
      const phoneRelayUrl = process.env["ARDEN_RELAY_PHONE_URL"]
      const server = yield* HttpServer.HttpServer
      const loopback = makeLoopback(server.address, options.localAccess)
      const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
      const log: RelayLog = (level, message, fields = {}) => {
        Effect.runFork(
          (level === "info" ? Effect.logInfo(message) : Effect.logWarning(message)).pipe(
            Effect.annotateLogs(fields)
          )
        )
      }
      const devices: DeviceRegistry = {
        list: () => run(store.devices()),
        add: (device) => run(store.addDevice(device)),
        revoke: (dev) => run(store.revokeDevice(dev)),
        seen: (dev, at) => run(store.touchDevice(dev, at.toISOString())),
        setPush: (dev, push) => run(store.setPush(dev, push))
      }
      const commands: CommandLog = {
        find: (cid) => run(store.command(cid)),
        begin: (input) => run(store.beginCommand(input)),
        finish: (input) => run(store.finishCommand(input))
      }

      let connector: { readonly url: string; readonly instance: RelayConnector } | undefined
      let identity: Promise<MacIdentity> | undefined
      let pairingUntil = 0
      let keeping = 0
      let lane: Promise<void> = Promise.resolve()

      const reconcile = (): Promise<void> => {
        lane = lane.then(async () => {
          const settings = await run(store.settings())
          const paired = await run(store.devices())
          const wanted =
            options.vault !== undefined &&
            settings.enabled &&
            (paired.length > 0 || pairingUntil > currentMillis())
          if (wanted && connector?.url === effectiveRelayUrl(settings.relayUrl)) return
          connector?.instance.stop()
          connector = undefined
          if (!wanted) return
          const instance = new RelayConnector({
            identity: await (identity ??= loadMacIdentity(options.vault)),
            relayUrl: effectiveRelayUrl(settings.relayUrl),
            phoneRelayUrl: phoneRelayUrl ?? effectiveRelayUrl(settings.relayUrl),
            macName:
              hostname()
                .replace(/\.local$/, "")
                .slice(0, 64) || "Mac",
            devices,
            commands,
            loopback,
            log,
            onDeviceLeft: () => {
              void reconcile()
                .then(() => run(holdAwake()))
                .catch((cause: unknown) =>
                  log("warning", "Relay could not settle after a phone left", {
                    cause: errorMessage(cause)
                  })
                )
            },
            setKeepAwake: (on) =>
              run(
                store
                  .updateSettings({ keepAwake: on })
                  .pipe(Effect.andThen(holdAwake()), Effect.asVoid)
              )
          })
          connector = { url: effectiveRelayUrl(settings.relayUrl), instance }
          await instance.start()
        })
        lane = lane.catch((cause: unknown) => {
          identity = undefined
          log("warning", "Relay could not start", {
            cause: errorMessage(cause)
          })
        })
        return lane
      }

      const holdAwake = Effect.fn("RelayService.holdAwake")(function* () {
        const settings = yield* store.settings()
        const paired = yield* store.devices()
        const runs = settings.keepAwake && paired.length > 0 ? yield* store.executingRuns() : 0
        if (runs > 0 !== keeping > 0) options.power?.keepAwake(runs > 0)
        keeping = runs
      })

      const wakes = yield* Queue.sliding<void>(1)
      const wake = Queue.offer(wakes, undefined)

      const tick = Effect.gen(function* () {
        yield* Effect.promise(reconcile)
        yield* wake
        yield* holdAwake()
        const now = yield* DateTime.now
        const retained = DateTime.formatIso(
          DateTime.subtract(now, { days: COMMAND_RETENTION_DAYS })
        )
        yield* store.pruneCommands(retained)
        yield* store.pruneNotified(retained)
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Relay upkeep failed", { cause })))
      yield* lifecycle.background(Effect.repeat(tick, Schedule.spaced(TICK)))

      const pushRoute = Effect.fn("RelayService.pushRoute")(function* () {
        const live = connector?.instance
        const targets = live?.state === "connected" ? live.pushTargets() : []
        const ready = identity
        if (live === undefined || targets.length === 0 || ready === undefined) return undefined
        const mac = yield* Effect.promise(() => ready)
        return {
          devices: targets.map((device) => device.dev),
          send: (notice, dev) => {
            const device = targets.find((target) => target.dev === dev)
            if (device === undefined) return false
            const sealed = pushPayload({ identity: mac, device, notice })
            return live.push({
              device,
              collapseId: collapseId(notice.askId ?? notice.sessionId),
              category: sealed.category,
              payload: sealed.payload
            })
          }
        } satisfies PushRoute
      })
      const reconcilePushes = Effect.gen(function* () {
        yield* deliverPushes(
          {
            state: {
              loopback,
              notices: store.notices,
              notified: store.notified
            },
            seeded: store.pushesSeeded,
            seed: store.seedNotified,
            claim: store.claimNotified,
            release: store.releaseNotified,
            present: store.personPresent,
            route: pushRoute
          },
          yield* Clock.currentTimeMillis
        )
      }).pipe(Effect.tapError((cause) => Effect.logWarning("Relay push failed", { cause })))
      yield* lifecycle.background(runPushes({ wakes, reconcile: reconcilePushes }))
      const watchJournal = Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* sessionEvents.open()
          yield* wake
          yield* Stream.runForEach(opened.stream, (delivery) =>
            delivery.kind === "reset" || PUSH_WAKES.has(delivery.event.type) ? wake : Effect.void
          )
        })
      ).pipe(Effect.tapError((cause) => Effect.logWarning("Relay push wake failed", { cause })))
      yield* lifecycle.background(
        watchJournal.pipe(Effect.retry(PUSH_RETRY), Effect.ignore, Effect.forever)
      )

      const unsubscribe = options.power?.onSleep((asleep) =>
        connector?.instance.presence(asleep ? "asleep" : "online")
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe?.()
          connector?.instance.stop()
          if (keeping > 0) options.power?.keepAwake(false)
        })
      )

      const status = Effect.fn("RelayService.status")(function* () {
        const settings = yield* store.settings()
        const paired = yield* store.devices()
        const live = connector?.instance
        const now = DateTime.formatIso(yield* DateTime.now)
        const connection = connectionOf({
          secure: options.vault !== undefined,
          enabled: settings.enabled,
          live: live?.state
        })
        const request = live?.pairRequest
        return {
          connection,
          enabled: settings.enabled,
          relay_url: effectiveRelayUrl(settings.relayUrl),
          keep_awake: settings.keepAwake,
          keeping_awake: keeping,
          pair_request:
            request === undefined
              ? null
              : { dev: request.dev, name: request.name, code: request.code },
          devices: paired.map((device) => {
            const online = live?.isOnline(device.dev) ?? false
            return {
              dev: device.dev,
              name: device.name,
              added_at: device.addedAt,
              last_seen_at: online ? now : (device.lastSeenAt ?? null),
              online
            }
          })
        } satisfies RelayStatus
      })

      const unavailable = (message: string) =>
        new RelayServiceError({ reason: "unavailable", message })

      const pair = Effect.fn("RelayService.pair")(function* () {
        if (options.vault === undefined)
          return yield* unavailable("No secure storage for relay keys")
        const settings = yield* store.settings()
        if (!settings.enabled) return yield* unavailable("The relay is off")
        pairingUntil = currentMillis() + PAIRING_WINDOW_MS
        yield* Effect.promise(reconcile)
        const instance = yield* Effect.promise(() => connected(() => connector?.instance))
        if (instance === undefined) return yield* unavailable("The relay is not connected")
        const offer = yield* Effect.tryPromise({
          try: () => instance.offer(),
          catch: (cause) => unavailable(errorMessage(cause, "Pairing failed"))
        })
        return {
          link: offer.link,
          expires_at: iso(offer.expires)
        } satisfies RelayPairOffer
      })

      const decide = Effect.fn("RelayService.decide")(function* (input: {
        readonly dev: string
        readonly allow: boolean
      }) {
        const instance = connector?.instance
        const decided =
          instance === undefined
            ? false
            : yield* Effect.promise(() => instance.decide(input.dev, input.allow))
        if (!decided)
          return yield* new RelayServiceError({ reason: "not_found", message: "No such request" })
        if (input.allow) pairingUntil = 0
        return yield* status()
      })

      const remove = Effect.fn("RelayService.remove")(function* (dev: string) {
        const known = yield* store.device(dev)
        if (known === undefined)
          return yield* new RelayServiceError({ reason: "not_found", message: "No such phone" })
        const instance = connector?.instance
        if (instance === undefined) yield* store.revokeDevice(dev)
        else yield* Effect.promise(() => instance.remove(dev))
        yield* Effect.promise(reconcile)
        yield* holdAwake()
        return yield* status()
      })

      const updateSettings = Effect.fn("RelayService.updateSettings")(function* (
        patch: RelaySettingsPatch
      ) {
        yield* store.updateSettings({
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.relay_url === undefined ? {} : { relayUrl: patch.relay_url }),
          ...(patch.keep_awake === undefined ? {} : { keepAwake: patch.keep_awake })
        })
        yield* Effect.promise(reconcile)
        yield* holdAwake()
        return yield* status()
      })

      return RelayService.of({ status, pair, decide, remove, updateSettings })
    })
  )

const connectionOf = (input: {
  readonly secure: boolean
  readonly enabled: boolean
  readonly live: RelayStatus["connection"] | undefined
}): RelayStatus["connection"] => {
  if (!input.secure) return "unavailable"
  if (!input.enabled) return "off"
  return input.live ?? "idle"
}

/** An APNs collapse id the relay accepts (url-safe, at most 64 characters). */
const collapseId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)

const connected = async (
  current: () => RelayConnector | undefined
): Promise<RelayConnector | undefined> => {
  const deadline = currentMillis() + CONNECT_WAIT_MS
  for (;;) {
    const instance = current()
    if (instance?.state === "connected") return instance
    if (currentMillis() > deadline) return undefined
    await sleep(50)
  }
}

const parseBody = (text: string): Schema.Json => {
  if (text === "") return null
  try {
    const value: Schema.Json = JSON.parse(text)
    return value
  } catch {
    return null
  }
}

const makeLoopback = (address: HttpServer.Address, access: LocalAccess | undefined): Loopback => {
  const base =
    address._tag === "TcpAddress" ? `http://127.0.0.1:${address.port}` : "http://127.0.0.1"
  const auth: Record<string, string> =
    access === undefined ? {} : { [LOCAL_CAPABILITY_HEADER]: access.capability }
  return {
    request: async ({ method, path, body, signal }) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal })
      })
      return { status: response.status, body: parseBody(await response.text()) }
    },
    events: async function* ({ path, lastEventId, signal }) {
      const response = await fetch(`${base}${path}`, {
        headers: {
          ...auth,
          accept: "text/event-stream",
          ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId })
        },
        signal
      })
      if (!response.ok || response.body === null)
        throw new Error(`The event stream answered ${response.status}`)
      for await (const frame of decodeSseFrameStream(response.body)) {
        yield frame.id === undefined ? { data: frame.data } : { id: frame.id, data: frame.data }
      }
    }
  }
}
