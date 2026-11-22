import { daemonDecoders, LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { RelayStore } from "../src/persistence/relay/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { DeferredToolCalls } from "../src/persistence/tools/deferred.js"
import { startConfigured } from "../src/serve/serve.js"
import { parseSettings } from "../src/serve/settings.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { relayLoopback } from "../src/relay/loopback.js"
import { runCommand } from "../src/relay/commands.js"
import { startServer, startServerWithLocalAccess, type ServerHandle } from "../src/server.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

const NO_CARD_ASKED_AT = "2026-11-21T09:00:00.000Z"

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

const waitingChat = (
  name: string,
  calls: Readonly<Record<string, string>>,
  commandLine: boolean,
  deferredCalls: Readonly<Record<string, string>> = {}
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore
    const chat = yield* ChatWriteStore
    const tools = yield* ToolExecutionStore
    const deferred = yield* DeferredToolCalls
    const session = yield* sessions.create({ name, ...(commandLine ? { commandLine } : {}) })
    const run = yield* chat.start({
      sessionId: session.sessionId,
      clientId: `${name}-start`,
      requestHash: `${name}-start`,
      assistantMessageId: `${name}-answer`,
      message: {
        message_id: `${name}-start`,
        client_id: `${name}-start`,
        role: ROLE.user,
        content: "Buy it",
        created_at: new Date().toISOString()
      }
    })
    for (const [toolCallId, toolName] of Object.entries(calls)) {
      const call = {
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId,
        toolName,
        changesState: false,
        arguments: { step: toolCallId }
      }
      yield* tools.begin(call)
      yield* tools.pause(call, { reason: "approval", preview: toolCallId })
    }
    for (const [toolCallId, toolName] of Object.entries(deferredCalls)) {
      const call = {
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId,
        toolName,
        arguments: { step: toolCallId },
        changesState: false
      }
      yield* tools.begin(call)
      yield* deferred.defer({ call: { ...call, data: undefined }, prompt: { preview: toolCallId } })
    }
    return run.runId
  })

const persistence = (databasePath: string) =>
  sqlitePersistenceLayer({ dataDir: null, filename: databasePath }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )

const statusOf = (
  databasePath: string,
  runId: string,
  toolCallId: string,
  table: "tool_approvals" | "deferred_tool_calls" = "tool_approvals"
): unknown => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database
      .prepare(`SELECT status FROM ${table} WHERE run_id = ? AND tool_call_id = ?`)
      .get(runId, toolCallId)
  } finally {
    database.close()
  }
}

const askedAt = (databasePath: string, runId: string, toolCallId: string): string | undefined => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = database
      .prepare(
        `SELECT requested_at FROM tool_approvals WHERE run_id = ? AND tool_call_id = ?
         UNION ALL
         SELECT requested_at FROM deferred_tool_calls WHERE run_id = ? AND tool_call_id = ?`
      )
      .get(runId, toolCallId, runId, toolCallId) as { readonly requested_at: string } | undefined
    return row?.requested_at
  } finally {
    database.close()
  }
}

const phoneCid = (runId: string, toolId: string, approve: boolean) =>
  `${runId}-${toolId}-${String(approve)}`

const phoneDecisions = [
  ["pay", true],
  ["pay-denied", false],
  ["write", true],
  ["deferred-pay", true],
  ["deferred-pay-denied", false],
  ["not-yet", true]
] as const

it("a card only the Arden app can grant is granted from the desktop, not from the phone or the command line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-app-only-settlement-"))
  const databasePath = join(directory, "arden.db")
  let server: ServerHandle | undefined
  try {
    const { shop, terminal } = await Effect.runPromise(
      Effect.gen(function* () {
        const shop = yield* waitingChat(
          "shop",
          {
            pay: "vault_pay",
            "pay-denied": "vault_pay",
            write: "file_write",
            kept: "file_write"
          },
          false,
          { "deferred-pay": "vault_pay", "deferred-pay-denied": "vault_pay" }
        )
        const relay = yield* RelayStore
        for (const [toolId, approve] of phoneDecisions)
          yield* relay.beginCommand({ cid: phoneCid(shop, toolId, approve), kind: "decide" })
        return {
          shop,
          terminal: yield* waitingChat(
            "terminal",
            { pay: "vault_pay", write: "file_write", kept: "file_write" },
            true
          )
        }
      }).pipe(Effect.provide(persistence(databasePath)))
    )
    server = await startServerWithLocalAccess({
      port: 0,
      databasePath,
      modelHost,
      localAccess: access
    })
    const phone = relayLoopback(
      { _tag: "TcpAddress", hostname: "127.0.0.1", port: server.port },
      access
    )
    const fromPhone = (runId: string, toolId: string, approve: boolean) =>
      runCommand(phone, phoneCid(runId, toolId, approve), {
        kind: "decide",
        args: {
          run_id: runId,
          tool_id: toolId,
          approve,
          asked_at: askedAt(databasePath, runId, toolId) ?? NO_CARD_ASKED_AT
        }
      })
    const post = (secret: string, runId: string, toolId: string, approved: boolean) =>
      server?.fetch("/tools/result", {
        method: "POST",
        headers: { "content-type": "application/json", [LOCAL_CAPABILITY_HEADER]: secret },
        body: JSON.stringify({ run_id: runId, tool_id: toolId, result: "", approved })
      })

    expect((await fromPhone(shop, "pay", true)).state).toBe("rejected")
    expect(statusOf(databasePath, shop, "pay")).toEqual({ status: "pending" })
    expect((await fromPhone(shop, "pay-denied", false)).state).toBe("done")
    expect(statusOf(databasePath, shop, "pay-denied")).toEqual({ status: "rejected" })
    expect((await fromPhone(shop, "write", true)).state).toBe("done")
    expect(statusOf(databasePath, shop, "write")).toEqual({ status: "approved" })

    expect((await fromPhone(shop, "deferred-pay", true)).state).toBe("rejected")
    expect(statusOf(databasePath, shop, "deferred-pay", "deferred_tool_calls")).toEqual({
      status: "pending"
    })
    expect((await fromPhone(shop, "deferred-pay-denied", false)).state).toBe("done")
    expect(statusOf(databasePath, shop, "deferred-pay-denied", "deferred_tool_calls")).toEqual({
      status: "rejected"
    })

    expect((await fromPhone(shop, "not-yet", true)).state).toBe("rejected")

    expect((await post(access.cliCapability, terminal, "pay", true))?.status).toBe(409)
    expect(statusOf(databasePath, terminal, "pay")).toEqual({ status: "pending" })
    expect((await post(access.cliCapability, terminal, "write", true))?.status).toBe(200)

    expect((await post(access.capability, shop, "pay", true))?.status).toBe(200)
    expect((await post(access.capability, shop, "pay", true))?.status).toBe(200)
    expect(statusOf(databasePath, shop, "pay")).toEqual({ status: "approved" })
    expect(statusOf(databasePath, shop, "kept")).toEqual({ status: "pending" })
  } finally {
    await server?.stop().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it("a server started without the Arden app denies a card only the app can grant, grants none, and grants the rest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-app-only-standalone-"))
  const databasePath = join(directory, "arden.db")
  let server: ServerHandle | undefined
  try {
    const shop = await Effect.runPromise(
      waitingChat(
        "shop",
        { pay: "vault_pay", "pay-denied": "vault_pay", write: "file_write" },
        false
      ).pipe(Effect.provide(persistence(databasePath)))
    )
    server = await startServer({ port: 0, databasePath, modelHost })
    const answer = (toolId: string, approved: boolean) =>
      server?.fetch("/tools/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: shop, tool_id: toolId, result: "", approved })
      })
    expect((await answer("pay", true))?.status).toBe(409)
    expect(statusOf(databasePath, shop, "pay")).toEqual({ status: "pending" })
    expect((await answer("pay-denied", false))?.status).toBe(200)
    expect(statusOf(databasePath, shop, "pay-denied")).toEqual({ status: "rejected" })
    expect((await answer("write", true))?.status).toBe(200)
    expect(statusOf(databasePath, shop, "write")).toEqual({ status: "approved" })
  } finally {
    await server?.stop().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it("a configured server's owner keeps its routes and ordinary grants, but grants no card only the app can", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-app-only-configured-"))
  const dataDirectory = join(root, "data")
  try {
    await mkdir(dataDirectory, { recursive: true })
    const databasePath = join(dataDirectory, "arden.db")
    const shop = await Effect.runPromise(
      waitingChat(
        "shop",
        { pay: "vault_pay", write: "file_write", kept: "file_write" },
        false
      ).pipe(Effect.provide(persistence(databasePath)))
    )
    const configured = await startConfigured(
      parseSettings({
        dataDirectory,
        provider: { kind: "responses", baseUrl: "http://127.0.0.1:9", apiKeyEnv: "SERVE_TEST_KEY" },
        model: "test-model",
        contextLimit: 100_000,
        memory: false,
        automations: false,
        skillRoots: [],
        idleCompactionAfterMs: 0
      }),
      startServerWithLocalAccess,
      { SERVE_TEST_KEY: "not-a-real-key" }
    )
    try {
      const published = daemonDecoders.cliAccess(
        JSON.parse(await readFile(configured.accessFile, "utf8"))
      ).capability
      const headers = { "content-type": "application/json", [LOCAL_CAPABILITY_HEADER]: published }
      const grant = (toolId: string) =>
        configured.server.fetch("/tools/result", {
          method: "POST",
          headers,
          body: JSON.stringify({ run_id: shop, tool_id: toolId, result: "", approved: true })
        })
      expect((await grant("pay")).status).toBe(409)
      expect(statusOf(databasePath, shop, "pay")).toEqual({ status: "pending" })
      expect((await grant("write")).status).toBe(200)
      expect(statusOf(databasePath, shop, "write")).toEqual({ status: "approved" })
      expect((await configured.server.fetch("/settings/intelligence", { headers })).status).toBe(
        200
      )
    } finally {
      await configured.stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
