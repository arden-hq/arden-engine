import {
  bodyAad,
  deviceId,
  fromB64url,
  fromUtf8,
  generateEd25519,
  generateX25519,
  openQueued,
  toB64url
} from "@arden-hq/relay-protocol"
import { Clock, Effect, Layer, ManagedRuntime, Queue } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { RelayStore, type PairedDevice } from "../src/persistence/relay/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import type { Notice } from "../src/persistence/sqlite/notices.js"
import { loadMacIdentity } from "../src/relay/identity.js"
import { memoryVault } from "./fixtures/memory-vault.js"
import type { Loopback, LoopbackResponse } from "../src/relay/ports.js"
import { deliverPushes, pushPayload, runPushes, type PushNotice } from "../src/relay/push.js"

describe("relay push", () => {
  it("pushes what the desktop would notify, sealed so only the phone reads it", async () => {
    const identity = await loadMacIdentity(memoryVault())
    const phoneEd = generateEd25519()
    const phoneX = generateX25519()
    const device: PairedDevice = {
      dev: deviceId(phoneEd.publicKey),
      name: "Test iPhone",
      edPub: toB64url(phoneEd.publicKey),
      xPub: toB64url(phoneX.publicKey),
      addedAt: "",
      lastSeenAt: undefined,
      push: undefined
    }
    const notice = {
      key: "ask:approval:run-1:call-1",
      kind: "approval",
      title: "Taxes",
      body: "Edit notes.md",
      sessionId: "chat-1",
      collapseId: "call-1",
      askId: "call-1",
      runId: "run-1",
      askedAt: "2026-11-21T09:00:00.000Z"
    } as const
    const sealed = pushPayload({ identity, device, notice })
    expect(sealed.category).toBe("arden.approval")
    const payload: unknown = JSON.parse(fromUtf8(sealed.payload))
    expect(payload).toMatchObject({
      aps: {
        alert: { title: "Arden", body: "An approval request" },
        "mutable-content": 1,
        category: "arden.approval",
        "thread-id": "chat-1"
      }
    })
    const e =
      typeof payload === "object" && payload !== null && "e" in payload ? payload.e : undefined
    if (typeof e !== "string") throw new Error("no sealed blob")
    const opened = openQueued({
      macStatic: phoneX,
      phoneStaticPublic: identity.x.publicKey,
      body: fromB64url(e),
      aad: bodyAad({ sender: identity.macId, receiver: device.dev })
    })
    expect(JSON.parse(fromUtf8(opened))).toEqual({
      kind: "approval",
      title: "Taxes",
      body: "Edit notes.md",
      session_id: "chat-1",
      ask_id: "call-1",
      run_id: "run-1",
      asked_at: "2026-11-21T09:00:00.000Z"
    })
  })

  it("a post's phone alert says a message came, not that a run stopped", async () => {
    const identity = await loadMacIdentity(memoryVault())
    const phoneEd = generateEd25519()
    const device: PairedDevice = {
      dev: deviceId(phoneEd.publicKey),
      name: "Test iPhone",
      edPub: toB64url(phoneEd.publicKey),
      xPub: toB64url(generateX25519().publicKey),
      addedAt: "",
      lastSeenAt: undefined,
      push: undefined
    }
    const sealed = pushPayload({
      identity,
      device,
      notice: {
        key: "post:1",
        kind: "finished",
        title: "Taxes",
        body: "The bank wrote back.",
        sessionId: "chat-1",
        collapseId: "post:1",
        askId: undefined,
        news: "posted"
      }
    })
    const body: string = JSON.parse(fromUtf8(sealed.payload)).aps.alert.body
    expect(body).toMatch(/message/i)
    expect(body).not.toMatch(/finish|stopp/i)
  })

  it("two posts in one chat open that chat, and neither replaces the other on the phone", async () => {
    const world = makeWorld({ seeded: true })
    const sent: Array<PushNotice> = []
    const posted = {
      record: "entity",
      status: "posted",
      purpose: null,
      chatSessionId: "space-chat"
    } as const
    world.notices = [
      notice("post-1", { ...posted, key: "post:1" }),
      notice("post-2", { ...posted, key: "post:2" })
    ]
    world.onSend = (pushed) => sent.push(pushed)
    await world.reconcile()
    expect(sent.map((pushed) => [pushed.sessionId, pushed.collapseId])).toEqual([
      ["space-chat", "post:1"],
      ["space-chat", "post:2"]
    ])
  })

  it("a question collapses on the question, and an approval on its call in its run", async () => {
    const world = makeWorld({ seeded: true })
    const sent: Array<PushNotice> = []
    world.asks = [question("q-1"), approval("run-1", "call-1"), approval("run-2", "call-1")]
    world.onSend = (pushed) => sent.push(pushed)
    await world.reconcile()
    world.asks = [approval("run-1", "call-1", "2026-10-12T09:59:30.000Z")]
    await world.reconcile()
    const [asked, otherRun, askedAgain] = sent.slice(1).map((pushed) => pushed.collapseId)
    expect(sent[0]?.collapseId).toBe("q-1")
    expect(askedAgain).toBe(asked)
    expect(otherRun).not.toBe(asked)
    for (const pushed of sent) expect(pushed.collapseId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(new Set(sent.map((pushed) => pushed.key)).size).toBe(4)
    expect(sent.slice(1).map((pushed) => [pushed.runId, pushed.askId, pushed.askedAt])).toEqual([
      ["run-1", "call-1", "2026-10-12T09:58:00.000Z"],
      ["run-2", "call-1", "2026-10-12T09:58:00.000Z"],
      ["run-1", "call-1", "2026-10-12T09:59:30.000Z"]
    ])
  })

  it("a restart neither repeats a push nor skips an ask that opened while Arden was down", async () => {
    const world = makeWorld({ seeded: true })
    world.asks = [question("q-1")]
    expect(await world.reconcile()).toEqual(["ask:question:q-1"])
    world.asks = [question("q-1"), question("q-2")]
    expect(await world.reconcile()).toEqual(["ask:question:q-2"])
    expect(await world.reconcile()).toEqual([])
  })

  it("with call ids of any length, each asking pushes once to each phone, and a call asked again pushes again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-relay-push-keys-"))
    const store = ManagedRuntime.make(
      sqlitePersistenceLayer({ dataDir: null, filename: join(directory, "arden.db") }).pipe(
        Layer.provide(PersistenceWriteQueue.layer)
      )
    )
    try {
      const longCall = `call_${"x".repeat(400)}`
      const otherCall = `call_${"y".repeat(400)}`
      const phones = ["a".repeat(22), "b".repeat(22)]
      let asks: ReadonlyArray<ReturnType<typeof approval>> = []
      const sent: Array<string> = []
      const loopback: Loopback = {
        request: async () => ({ status: 200, body: { asks } }),
        events: async function* () {}
      }
      const reconcile = () =>
        store.runPromise(
          Effect.gen(function* () {
            const relay = yield* RelayStore
            yield* deliverPushes(
              {
                state: { loopback, notices: () => Effect.succeed([]), notified: relay.notified },
                seeded: relay.pushesSeeded,
                seed: relay.seedNotified,
                claim: relay.claimNotified,
                release: relay.releaseNotified,
                present: () => Effect.succeed(false),
                route: () =>
                  Effect.succeed({
                    devices: phones,
                    send: (notice: PushNotice, dev: string) => {
                      sent.push(`${notice.askId?.slice(0, 6)} ${notice.askedAt} ${dev.slice(0, 1)}`)
                      return true
                    }
                  })
              },
              NOW
            )
          })
        )
      await reconcile()
      asks = [approval("run-1", longCall), approval("run-1", otherCall)]
      await reconcile()
      await reconcile()
      asks = [approval("run-1", longCall, "2026-10-12T09:59:30.000Z"), approval("run-1", otherCall)]
      await reconcile()
      expect(sent).toEqual([
        "call_x 2026-10-12T09:58:00.000Z a",
        "call_x 2026-10-12T09:58:00.000Z b",
        "call_y 2026-10-12T09:58:00.000Z a",
        "call_y 2026-10-12T09:58:00.000Z b",
        "call_x 2026-10-12T09:59:30.000Z a",
        "call_x 2026-10-12T09:59:30.000Z b"
      ])
    } finally {
      await store.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("a push that throws is released and tried again; the notices after it are still sent", async () => {
    const world = makeWorld({ seeded: true })
    world.asks = [question("q-1"), question("q-2")]
    world.failing = new Set(["ask:question:q-1"])
    expect(await world.reconcile()).toEqual(["ask:question:q-2"])
    expect(world.sent).toEqual(["ask:question:q-2"])
    world.failing = new Set()
    expect(await world.reconcile()).toEqual(["ask:question:q-1"])
    expect(await world.reconcile()).toEqual([])
    expect(world.sent).toEqual(["ask:question:q-2", "ask:question:q-1"])
  })

  it("one phone failing does not block the others, and only it is tried again", async () => {
    const world = makeWorld({ seeded: true })
    world.devices = ["a", "b", "c"]
    world.refusing = new Set(["b"])
    world.asks = [question("q-1")]
    expect(await world.reconcile()).toEqual([])
    expect(world.sent).toEqual(["ask:question:q-1>a", "ask:question:q-1>c"])
    world.refusing = new Set()
    expect(await world.reconcile()).toEqual(["ask:question:q-1"])
    expect(world.sent).toEqual(["ask:question:q-1>a", "ask:question:q-1>c", "ask:question:q-1>b"])
    expect(await world.reconcile()).toEqual([])
  })

  it("records nothing while no phone can take a push; the first reconcile with one seeds, later asks push", async () => {
    const world = makeWorld({ seeded: false })
    world.devices = []
    world.asks = [question("q-1")]
    expect(await world.reconcile()).toEqual([])
    expect(world.seeded()).toBe(false)
    world.devices = ["phone"]
    expect(await world.reconcile()).toEqual([])
    expect(world.seeded()).toBe(true)
    world.asks = [question("q-1"), question("q-2")]
    expect(await world.reconcile()).toEqual(["ask:question:q-2"])
  })

  it("an ask passed over while you are at the Mac is pushed once you leave, if it is still open", async () => {
    const world = makeWorld({ seeded: true })
    world.asks = [question("q-1")]
    world.present = true
    expect(await world.reconcile()).toEqual([])
    world.present = false
    expect(await world.reconcile()).toEqual(["ask:question:q-1"])
    expect(await world.reconcile()).toEqual([])
  })

  it("pushes each record the rule lets through once: finished chats and Automations that are unread, failures and posts; never the model-only, read, paused, Task-done or chatless", async () => {
    const world = makeWorld({ seeded: true })
    world.notices = [
      notice("unread", {}),
      notice("read", { unread: false }),
      notice("model-only", { shown: false }),
      notice("quiet", { status: "silent" }),
      notice("cancelled", { status: "cancelled" }),
      notice("waiting", { status: "waiting" }),
      notice("failed", { status: "failed", unread: false }),
      notice("paused", {
        record: "entity",
        key: "automation-paused:3",
        status: "paused",
        purpose: null
      }),
      notice("task-done", { record: "entity", key: "task-done:4", status: "done", purpose: null }),
      notice("posted", { record: "entity", key: "post:5", status: "posted", purpose: null }),
      notice("worker", { purpose: "task_execution" }),
      notice("nowhere", { status: "failed", chatSessionId: null })
    ]
    expect(await world.reconcile()).toEqual(["ending:unread", "ending:failed", "post:5"])
    expect(world.bodies).toEqual(["Sent the summary", "Sent the summary", "Sent the summary"])
    expect(world.news).toEqual(["finished", "stopped", "posted"])
    expect(await world.reconcile()).toEqual([])
  })

  it("a read that fails is retried, waiting longer each time, and the loop goes on", async () => {
    const tries: number[] = []
    await Effect.gen(function* () {
      const wakes = yield* Queue.sliding<void>(1)
      const reconcile = Effect.gen(function* () {
        tries.push(yield* Clock.currentTimeMillis)
        if (tries.length < 4) return yield* Effect.fail("down")
      })
      yield* Effect.forkChild(runPushes({ wakes, reconcile }))
      yield* Queue.offer(wakes, undefined)
      yield* TestClock.adjust("10 seconds")
      yield* Queue.offer(wakes, undefined)
      yield* TestClock.adjust("1 second")
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped, Effect.runPromise)
    expect(tries).toEqual([0, 1_000, 3_000, 7_000, 10_000])
  })
})

const NOW = Date.parse("2026-10-12T10:00:00.000Z")
const NOW_ISO = "2026-10-12T09:59:00.000Z"

const question = (id: string) => ({
  kind: "question",
  question_id: id,
  session_id: `chat-${id}`,
  place: "Lab",
  prompt: id
})

const approval = (runId: string, toolId: string, askedAt = "2026-10-12T09:58:00.000Z") => ({
  kind: "approval",
  tool_id: toolId,
  run_id: runId,
  session_id: `chat-${runId}`,
  place: "Lab",
  title: "Edit notes.md",
  asked_at: askedAt
})

const notice = (id: string, fields: Partial<Notice>): Notice => ({
  key: `ending:${id}`,
  record: "ending",
  status: "finished",
  shown: true,
  title: "Morning brief",
  text: "Sent the summary",
  chatSessionId: `own-${id}`,
  automationId: null,
  itemId: null,
  unread: true,
  occurredAt: NOW_ISO,
  purpose: "chat",
  ...fields
})

const makeWorld = (options: { readonly seeded: boolean }) => {
  const notified = new Set<string>()
  let seeded = options.seeded
  const world = {
    seeded: () => seeded,
    asks: [] as ReadonlyArray<ReturnType<typeof question> | ReturnType<typeof approval>>,
    notices: [] as ReadonlyArray<Notice>,
    present: false,
    failing: new Set<string>(),
    devices: ["phone"] as ReadonlyArray<string>,
    refusing: new Set<string>(),
    sent: [] as Array<string>,
    bodies: [] as Array<string>,
    news: [] as Array<PushNotice["news"]>,
    onSend: (_notice: PushNotice): void => {},
    reconcile: async (): Promise<ReadonlyArray<string>> => {
      const loopback: Loopback = {
        request: async ({ path }): Promise<LoopbackResponse> => {
          if (path === "/mobile/home") return { status: 200, body: { asks: world.asks } }
          return { status: 404, body: {} }
        },
        events: async function* () {}
      }
      const taken: Array<string> = []
      await Effect.runPromise(
        deliverPushes(
          {
            state: {
              loopback,
              notices: () => Effect.succeed(world.notices),
              notified: (keys) => Effect.succeed(new Set(keys.filter((key) => notified.has(key))))
            },
            seeded: () => Effect.succeed(seeded),
            seed: (keys) =>
              Effect.sync(() => {
                for (const key of keys) notified.add(key)
                seeded = true
              }),
            claim: (key) =>
              Effect.sync(() => {
                if (notified.has(key)) return false
                notified.add(key)
                if (!key.includes("|")) taken.push(key)
                return true
              }),
            release: (key) =>
              Effect.sync(() => {
                notified.delete(key)
              }),
            present: () => Effect.succeed(world.present),
            route: () =>
              Effect.succeed(
                world.devices.length === 0
                  ? undefined
                  : {
                      devices: world.devices,
                      send: (notice: PushNotice, dev: string) => {
                        if (world.failing.has(notice.key)) throw new Error("device unreachable")
                        if (world.refusing.has(dev)) return false
                        world.sent.push(
                          world.devices.length > 1 ? `${notice.key}>${dev}` : notice.key
                        )
                        if (notice.kind === "finished") {
                          world.bodies.push(notice.body)
                          world.news.push(notice.news)
                        }
                        world.onSend(notice)
                        return true
                      }
                    }
              )
          },
          NOW
        )
      )
      return taken
    }
  }
  return world
}
