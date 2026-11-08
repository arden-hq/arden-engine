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
import { Clock, Effect, Queue } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import type { PairedDevice } from "../src/persistence/relay/store.js"
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
      askId: "call-1",
      runId: "run-1"
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
      run_id: "run-1"
    })
  })

  it("a restart neither repeats a push nor skips an ask that opened while Arden was down", async () => {
    const world = makeWorld({ seeded: true })
    world.asks = [question("q-1")]
    expect(await world.reconcile()).toEqual(["ask:question:q-1"])
    world.asks = [question("q-1"), question("q-2")]
    expect(await world.reconcile()).toEqual(["ask:question:q-2"])
    expect(await world.reconcile()).toEqual([])
  })

  it("keys an approval by its run, so the same tool call id in another run is another ask", async () => {
    const world = makeWorld({ seeded: true })
    world.asks = [approval("run-1", "call-1"), approval("run-2", "call-1")]
    expect(await world.reconcile()).toEqual([
      "ask:approval:run-1:call-1",
      "ask:approval:run-2:call-1"
    ])
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

  it("a push with the socket down is released, then sent once it is up", async () => {
    const world = makeWorld({ seeded: true })
    world.asks = [question("q-1")]
    world.refusing = new Set(["phone"])
    expect(await world.reconcile()).toEqual([])
    expect(world.sent).toEqual([])
    world.refusing = new Set()
    expect(await world.reconcile()).toEqual(["ask:question:q-1"])
    expect(await world.reconcile()).toEqual([])
    expect(world.sent).toEqual(["ask:question:q-1"])
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

  it("the first reconcile of this release records what waits (old keys differ) and pushes none of it", async () => {
    const world = makeWorld({ seeded: false })
    world.asks = [question("q-1")]
    world.notices = [notice("a", {})]
    expect(await world.reconcile()).toEqual([])
    expect(world.sent).toEqual([])
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

  it("pushes each record the rule lets through once: finished chats and Automations that are unread, and failures; never the model-only, read, paused, Task-done or chatless", async () => {
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
      notice("worker", { purpose: "task_execution" }),
      notice("nowhere", { status: "failed", chatSessionId: null })
    ]
    expect(await world.reconcile()).toEqual(["ending:unread", "ending:failed"])
    expect(world.bodies).toEqual(["Sent the summary", "Sent the summary"])
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

const approval = (runId: string, toolId: string) => ({
  kind: "approval",
  tool_id: toolId,
  run_id: runId,
  session_id: `chat-${runId}`,
  place: "Lab",
  title: "Edit notes.md"
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
                        if (notice.kind === "finished") world.bodies.push(notice.body)
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
