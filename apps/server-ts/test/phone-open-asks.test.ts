import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { INBOX_ITEM_LIMIT } from "@arden-hq/protocol/inbox"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { startServerWithLocalAccess } from "../src/server.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

const access = {
  host: "app" as const,
  capability: "desktop-secret-0000000000000000000000",
  rendererOrigin: "http://127.0.0.1",
  cliCapability: "command-line-secret-00000000000000000",
  phoneCapability: "phone-secret-0000000000000000000000000"
}

const modelHost = {
  models: [
    {
      id: "fixture-model",
      name: "Fixture model",
      provider: { id: "fixture", name: "Fixture" },
      reasoningEfforts: [],
      context: { hardLimit: 128_000, compactionTrigger: 100_000 }
    }
  ],
  defaults: {
    chatModelId: "fixture-model",
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
} as const

const chat = Effect.fn(function* (
  name: string,
  asks: ReadonlyArray<string>,
  cards: ReadonlyArray<string>
) {
  const session = yield* (yield* SessionStore).create({ name })
  const run = yield* (yield* ChatWriteStore).start({
    sessionId: session.sessionId,
    clientId: `${name}-start`,
    requestHash: `${name}-start`,
    assistantMessageId: `${name}-answer`,
    message: {
      message_id: `${name}-start`,
      client_id: `${name}-start`,
      role: ROLE.user,
      content: "Write them all",
      created_at: new Date().toISOString()
    }
  })
  for (const toolCallId of asks)
    yield* (yield* WorkStore).askQuestion({
      runId: run.runId,
      toolCallId,
      content: { prompt: "Which folder?", detail: null, choices: [] }
    })
  const tools = yield* ToolExecutionStore
  for (const toolCallId of cards) {
    const call = {
      runId: run.runId,
      sessionId: session.sessionId,
      toolCallId,
      toolName: "file_write",
      changesState: false,
      arguments: { toolCallId }
    }
    yield* tools.begin(call)
    yield* tools.pause(call, { reason: "approval", preview: `Write ${toolCallId}` })
  }
  return run.runId
})

const waiting = (cards: number) =>
  chat(
    "Busy chat",
    ["ask"],
    Array.from({ length: cards }, (_, index) => `write-${index}`)
  )

const read = async (
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  path: string
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(path, {
    headers: { [LOCAL_CAPABILITY_HEADER]: access.phoneCapability }
  })
  return { status: response.status, body: response.ok ? await response.json() : null }
}

const phoneAsks = async (fetch: (path: string, init?: RequestInit) => Promise<Response>) => {
  const response = await fetch("/mobile/home", {
    headers: { [LOCAL_CAPABILITY_HEADER]: access.phoneCapability }
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    readonly asks: ReadonlyArray<{ readonly kind: string }>
  }
  return {
    questions: body.asks.filter((ask) => ask.kind === "question").length,
    approvals: body.asks.filter((ask) => ask.kind === "approval").length
  }
}

const persistence = (databasePath: string) =>
  sqlitePersistenceLayer({ dataDir: null, filename: databasePath }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )

const withServer = async (
  prepare: Effect.Effect<unknown, unknown, Layer.Success<ReturnType<typeof persistence>>>,
  build: (fetch: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>
) => {
  const directory = await mkdtemp(join(tmpdir(), "arden-phone-open-asks-"))
  const databasePath = join(directory, "arden.db")
  try {
    const store = ManagedRuntime.make(persistence(databasePath))
    await store.runPromise(prepare)
    await store.dispose()
    const server = await startServerWithLocalAccess({
      port: 0,
      databasePath,
      modelHost,
      localAccess: access
    })
    try {
      await build(server.fetch)
    } finally {
      await server.stop()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it("the phone and its pushes list every open ask, also past the Inbox's length", async () => {
  await withServer(waiting(INBOX_ITEM_LIMIT + 1), async (fetch) => {
    expect(await phoneAsks(fetch)).toEqual({ questions: 1, approvals: INBOX_ITEM_LIMIT + 1 })
  })
})

it("the phone lists asks from more chats than one lookup reads, each named by its chat", async () => {
  const chats = INBOX_ITEM_LIMIT + 1
  await withServer(
    Effect.forEach(
      Array.from({ length: chats }, (_, index) => `Chat ${index}`),
      (name) => chat(name, [], ["write"])
    ),
    async (fetch) => {
      const home = await read(fetch, "/mobile/home")
      expect(home.status).toBe(200)
      const places = (
        home.body as { readonly asks: ReadonlyArray<{ readonly place: string }> }
      ).asks
        .map((ask) => ask.place)
        .toSorted()
      expect(places).toEqual(
        Array.from({ length: chats }, (_, index) => `Chat ${index}`).toSorted()
      )
      expect((await read(fetch, "/mobile/spaces")).status).toBe(200)
    }
  )
})

it("clearing the Inbox hides nothing from the phone and its pushes", async () => {
  await withServer(waiting(1), async (fetch) => {
    const open = { questions: 1, approvals: 1 }
    expect(await phoneAsks(fetch)).toEqual(open)
    const cleared = await fetch("/inbox/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_CAPABILITY_HEADER]: access.capability },
      body: JSON.stringify({ scope: "all" })
    })
    expect(cleared.status).toBe(200)
    expect(await phoneAsks(fetch)).toEqual(open)
  })
})
