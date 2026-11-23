import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import type { MacMessage } from "@arden-hq/relay-protocol"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { RelayStore } from "../src/persistence/relay/store.js"
import { DeferredToolCalls } from "../src/persistence/tools/deferred.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { PhoneSession } from "../src/relay/phone.js"
import type { CommandLog, Loopback } from "../src/relay/ports.js"
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

const waitingChat = (name: string, commandLine: boolean) =>
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
        content: "Write it",
        created_at: new Date().toISOString()
      }
    })
    for (const toolCallId of ["write", "second", "kept"]) {
      const call = {
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId,
        toolName: "file_write",
        changesState: false,
        arguments: { step: toolCallId }
      }
      yield* tools.begin(call)
      yield* tools.pause(call, { reason: "approval", preview: toolCallId })
    }
    for (const toolCallId of ["later", "later-kept"]) {
      const call = {
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId,
        toolName: "file_write",
        changesState: false,
        arguments: { step: toolCallId }
      }
      yield* tools.begin(call)
      yield* deferred.defer({ call: { ...call, data: undefined }, prompt: { preview: toolCallId } })
    }
    return run.runId
  })

const receiptOf = (databasePath: string, cid: string): unknown => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database
      .prepare("SELECT kind, state, result_json FROM relay_commands WHERE cid = ?")
      .get(cid)
  } finally {
    database.close()
  }
}

const askedAt = (databasePath: string, runId: string, toolCallId: string): string => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = database
      .prepare(
        `SELECT requested_at FROM tool_approvals WHERE run_id = ? AND tool_call_id = ?
         UNION ALL
         SELECT requested_at FROM deferred_tool_calls WHERE run_id = ? AND tool_call_id = ?`
      )
      .get(runId, toolCallId, runId, toolCallId) as { readonly requested_at: string }
    return row.requested_at
  } finally {
    database.close()
  }
}

const cardStatus = (
  databasePath: string,
  runId: string,
  toolCallId = "write",
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

const storeAt = (databasePath: string) =>
  ManagedRuntime.make(
    sqlitePersistenceLayer({ dataDir: null, filename: databasePath }).pipe(
      Layer.provide(PersistenceWriteQueue.layer)
    )
  )

const prepare = Effect.gen(function* () {
  const relay = yield* RelayStore
  yield* relay.beginCommand({ cid: "send-1", kind: "send" })
  yield* relay.finishCommand({ cid: "send-1", state: "done", result: { status: "accepted" } })
  yield* relay.beginCommand({ cid: "send-2", kind: "send" })
  yield* relay.beginCommand({ cid: "decide-2", kind: "decide" })
  yield* relay.beginCommand({ cid: "decide-later", kind: "decide" })
  for (const cid of ["decide-3", "decide-later-3"]) {
    yield* relay.beginCommand({ cid, kind: "decide" })
    yield* relay.finishCommand({
      cid,
      state: "rejected",
      result: { message: "Arden did not answer." }
    })
  }
  return { runId: yield* waitingChat("phone", false), cliRunId: yield* waitingChat("cli", true) }
})

const inDirectory = async (build: (databasePath: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "arden-relay-receipt-"))
  try {
    await build(join(directory, "arden.db"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const commandLog = (store: ManagedRuntime.ManagedRuntime<RelayStore, unknown>): CommandLog => ({
  find: (cid) =>
    store.runPromise(
      Effect.gen(function* () {
        return yield* (yield* RelayStore).command(cid)
      })
    ),
  begin: (input) =>
    store.runPromise(
      Effect.gen(function* () {
        return yield* (yield* RelayStore).beginCommand(input)
      })
    ),
  finish: (input) =>
    store.runPromise(
      Effect.gen(function* () {
        yield* (yield* RelayStore).finishCommand(input)
      })
    )
})

it("a phone decision whose answer is lost after it took effect is acknowledged done, also when sent again", async () => {
  await inDirectory(async (databasePath) => {
    const store = storeAt(databasePath)
    try {
      const phone = await store.runPromise(prepare)
      const losing: Loopback = {
        request: async ({ path }) => {
          if (path !== "/tools/result") return { status: 404, body: null }
          await store.runPromise(
            Effect.gen(function* () {
              yield* (yield* RelayStore).finishCommand({
                cid: "decide-1",
                state: "done",
                result: { status: "ok" }
              })
            })
          )
          throw new Error("the answer was lost")
        },
        events: async function* () {}
      }
      const acks: Array<MacMessage> = []
      const session = new PhoneSession({
        dev: "phone",
        loopback: losing,
        commands: commandLog(store),
        log: () => {},
        registerPush: async () => {},
        setKeepAwake: async () => {}
      })
      session.attach((message) => acks.push(message))
      const allow = {
        t: "cmd" as const,
        cid: "decide-1",
        ts: Date.now(),
        kind: "decide" as const,
        args: { run_id: phone.runId, tool_id: "write", approve: true }
      }
      await session.command(allow)
      await session.command(allow)
      expect(acks).toEqual([
        { t: "cmd_ack", cid: "decide-1", state: "done", result: { status: "ok" } },
        { t: "cmd_ack", cid: "decide-1", state: "done", result: { status: "ok" } }
      ])
      const kept = await store.runPromise(
        Effect.gen(function* () {
          return yield* (yield* RelayStore).command("decide-1")
        })
      )
      expect(kept).toMatchObject({ kind: "decide", state: "done", result: { status: "ok" } })
    } finally {
      await store.dispose()
    }
  })
})

it("a decision keeps a result only for the relay's own running decide", async () => {
  await inDirectory(async (databasePath) => {
    const store = storeAt(databasePath)
    const phone = await store.runPromise(prepare)
    await store.dispose()
    const server = await startServerWithLocalAccess({
      port: 0,
      databasePath,
      modelHost,
      localAccess: access
    })
    try {
      const decideCard = (secret: string, runId: string, toolId: string, commandId: string) =>
        server.fetch("/tools/result", {
          method: "POST",
          headers: { "content-type": "application/json", [LOCAL_CAPABILITY_HEADER]: secret },
          body: JSON.stringify({
            run_id: runId,
            tool_id: toolId,
            result: "",
            approved: true,
            command_id: commandId,
            asked_at: askedAt(databasePath, runId, toolId)
          })
        })
      const decide = (secret: string, runId: string, commandId: string) =>
        decideCard(secret, runId, "write", commandId)
      const unchanged = { kind: "send", state: "done", result_json: '{"status":"accepted"}' }
      const running = { kind: "decide", state: "running", result_json: null }
      const done = { kind: "decide", state: "done", result_json: '{"status":"ok"}' }
      const pending = { status: "pending" }
      expect((await decide(access.cliCapability, phone.cliRunId, "decide-2")).status).toBe(200)
      expect(cardStatus(databasePath, phone.cliRunId)).toEqual({ status: "approved" })
      expect(receiptOf(databasePath, "decide-2")).toEqual(running)
      expect((await decide(access.phoneCapability, phone.runId, "send-1")).status).toBe(409)
      expect(cardStatus(databasePath, phone.runId)).toEqual(pending)
      expect(receiptOf(databasePath, "send-1")).toEqual(unchanged)
      expect(
        (await decideCard(access.phoneCapability, phone.cliRunId, "second", "send-2")).status
      ).toBe(409)
      expect(cardStatus(databasePath, phone.cliRunId, "second")).toEqual(pending)
      expect(receiptOf(databasePath, "send-2")).toEqual({ ...running, kind: "send" })
      expect(
        (await decideCard(access.phoneCapability, phone.runId, "second", "decide-2")).status
      ).toBe(200)
      expect(cardStatus(databasePath, phone.runId, "second")).toEqual({ status: "approved" })
      expect(receiptOf(databasePath, "decide-2")).toEqual(done)
      expect(
        (await decideCard(access.phoneCapability, phone.runId, "later", "decide-later")).status
      ).toBe(200)
      expect(cardStatus(databasePath, phone.runId, "later", "deferred_tool_calls")).toEqual({
        status: "approved"
      })
      expect(receiptOf(databasePath, "decide-later")).toEqual(done)
    } finally {
      await server.stop()
    }
  })
})

it("a decision that reaches Arden after the phone was told it failed settles nothing", async () => {
  await inDirectory(async (databasePath) => {
    const store = storeAt(databasePath)
    const phone = await store.runPromise(prepare)
    await store.dispose()
    const server = await startServerWithLocalAccess({
      port: 0,
      databasePath,
      modelHost,
      localAccess: access
    })
    try {
      const decideCard = (toolId: string, commandId: string) =>
        server.fetch("/tools/result", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_CAPABILITY_HEADER]: access.phoneCapability
          },
          body: JSON.stringify({
            run_id: phone.runId,
            tool_id: toolId,
            result: "",
            approved: true,
            command_id: commandId,
            asked_at: askedAt(databasePath, phone.runId, toolId)
          })
        })
      const rejected = {
        kind: "decide",
        state: "rejected",
        result_json: '{"message":"Arden did not answer."}'
      }
      expect((await decideCard("write", "decide-3")).status).toBe(409)
      expect(cardStatus(databasePath, phone.runId)).toEqual({ status: "pending" })
      expect(receiptOf(databasePath, "decide-3")).toEqual(rejected)
      expect((await decideCard("later", "decide-later-3")).status).toBe(409)
      expect(cardStatus(databasePath, phone.runId, "later", "deferred_tool_calls")).toEqual({
        status: "pending"
      })
      expect(receiptOf(databasePath, "decide-later-3")).toEqual(rejected)
    } finally {
      await server.stop()
    }
  })
})
