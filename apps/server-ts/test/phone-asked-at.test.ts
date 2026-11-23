import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { RelayStore } from "../src/persistence/relay/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { runCommand } from "../src/relay/commands.js"
import { relayLoopback } from "../src/relay/loopback.js"
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

const waitingChat = (name: string, cards: ReadonlyArray<string>, commandLine: boolean) =>
  Effect.gen(function* () {
    const tools = yield* ToolExecutionStore
    const session = yield* (yield* SessionStore).create({
      name,
      ...(commandLine ? { commandLine } : {})
    })
    const run = yield* (yield* ChatWriteStore).start({
      sessionId: session.sessionId,
      clientId: `${name}-start`,
      requestHash: `${name}-start`,
      assistantMessageId: `${name}-answer`,
      message: {
        message_id: `${name}-start`,
        client_id: `${name}-start`,
        role: ROLE.user,
        content: "Write them",
        created_at: new Date().toISOString()
      }
    })
    for (const toolCallId of [...cards, "kept"]) {
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
    return run.runId
  })

const PHONE_CARDS = [
  "old-allow",
  "old-deny",
  "new-allow",
  "new-deny",
  "stale",
  "unknown",
  "desk"
] as const

const card = (databasePath: string, runId: string, toolCallId: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database
      .prepare(
        "SELECT status, requested_at FROM tool_approvals WHERE run_id = ? AND tool_call_id = ?"
      )
      .get(runId, toolCallId) as { readonly status: string; readonly requested_at: string }
  } finally {
    database.close()
  }
}

const command = (databasePath: string, cid: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database
      .prepare("SELECT state, result_json FROM relay_commands WHERE cid = ?")
      .get(cid) as { readonly state: string; readonly result_json: string | null } | undefined
  } finally {
    database.close()
  }
}

it("an iPhone answers a card only by naming when it was asked; other callers and features are unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-phone-asked-at-"))
  const databasePath = join(directory, "arden.db")
  try {
    const store = ManagedRuntime.make(
      sqlitePersistenceLayer({ dataDir: null, filename: databasePath }).pipe(
        Layer.provide(PersistenceWriteQueue.layer)
      )
    )
    const { phoneRun, cliRun } = await store.runPromise(
      Effect.gen(function* () {
        const phoneRun = yield* waitingChat("phone", PHONE_CARDS, false)
        const cliRun = yield* waitingChat("terminal", ["cli"], true)
        const relay = yield* RelayStore
        for (const toolId of PHONE_CARDS.filter((id) => id !== "unknown"))
          yield* relay.beginCommand({ cid: `cid-${toolId}`, kind: "decide" })
        return { phoneRun, cliRun }
      })
    )
    await store.dispose()
    const server = await startServerWithLocalAccess({
      port: 0,
      databasePath,
      modelHost,
      localAccess: access
    })
    try {
      const phone = relayLoopback(
        { _tag: "TcpAddress", hostname: "127.0.0.1", port: server.port },
        access
      )
      const fromPhone = (toolId: string, approve: boolean, askedAt?: string) =>
        runCommand(phone, `cid-${toolId}`, {
          kind: "decide",
          args: {
            run_id: phoneRun,
            tool_id: toolId,
            approve,
            ...(askedAt === undefined ? {} : { asked_at: askedAt })
          }
        })

      expect((await fromPhone("old-allow", true)).state).toBe("rejected")
      expect((await fromPhone("old-deny", false)).state).toBe("rejected")
      expect(card(databasePath, phoneRun, "old-allow").status).toBe("pending")
      expect(card(databasePath, phoneRun, "old-deny").status).toBe("pending")

      const allowAt = card(databasePath, phoneRun, "new-allow").requested_at
      const denyAt = card(databasePath, phoneRun, "new-deny").requested_at
      expect((await fromPhone("new-allow", true, allowAt)).state).toBe("done")
      expect((await fromPhone("new-deny", false, denyAt)).state).toBe("done")
      expect(card(databasePath, phoneRun, "new-allow").status).toBe("approved")
      expect(card(databasePath, phoneRun, "new-deny").status).toBe("rejected")

      expect((await fromPhone("stale", false, "2026-01-01T00:00:00.000Z")).state).toBe("rejected")
      expect(
        (await fromPhone("unknown", true, card(databasePath, phoneRun, "unknown").requested_at))
          .state
      ).toBe("rejected")
      expect(card(databasePath, phoneRun, "stale").status).toBe("pending")
      expect(card(databasePath, phoneRun, "unknown").status).toBe("pending")
      expect(command(databasePath, "cid-stale")).toEqual({ state: "running", result_json: null })

      const kept = command(databasePath, "cid-new-allow")
      expect(kept?.state).toBe("done")
      await fromPhone("new-allow", true, allowAt)
      expect(card(databasePath, phoneRun, "new-allow").status).toBe("approved")
      expect(command(databasePath, "cid-new-allow")).toEqual(kept)

      const home = await phone.request({ method: "GET", path: "/mobile/home" })
      expect(home.status).toBe(200)

      const post = (secret: string, runId: string, toolId: string) =>
        server.fetch("/tools/result", {
          method: "POST",
          headers: { "content-type": "application/json", [LOCAL_CAPABILITY_HEADER]: secret },
          body: JSON.stringify({ run_id: runId, tool_id: toolId, result: "", approved: true })
        })
      expect((await post(access.capability, phoneRun, "desk")).status).toBe(200)
      expect((await post(access.cliCapability, cliRun, "cli")).status).toBe(200)
      expect(card(databasePath, phoneRun, "desk").status).toBe("approved")
      expect(card(databasePath, cliRun, "cli").status).toBe("approved")
    } finally {
      await server.stop()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
