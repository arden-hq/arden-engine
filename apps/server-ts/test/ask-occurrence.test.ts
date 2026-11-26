import { decisionBody } from "./fixtures/chat-requests.js"
import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { runCommand } from "../src/relay/commands.js"
import { relayLoopback } from "../src/relay/loopback.js"
import { startServerWithLocalAccess, type ServerHandle } from "../src/server.js"
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

const Card = Schema.Struct({
  kind: Schema.String,
  status: Schema.String,
  requested_at: Schema.String
})

const cardOf = (databasePath: string, runId: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return Schema.decodeUnknownSync(Card)(
      database
        .prepare(
          "SELECT kind, status, requested_at FROM tool_approvals WHERE run_id = ? AND tool_call_id = 'write'"
        )
        .get(runId)
    )
  } finally {
    database.close()
  }
}

it.each([
  ["the clock moves", false],
  ["the clock stands still", true]
] as const)(
  "an answer to a card asked again in place answers only the card it was given for (%s)",
  async (_clock, frozen) => {
    const directory = await mkdtemp(join(tmpdir(), "arden-ask-occurrence-"))
    const databasePath = join(directory, "arden.db")
    let server: ServerHandle | undefined
    try {
      const layer = sqlitePersistenceLayer({ dataDir: null, filename: databasePath }).pipe(
        Layer.provide(PersistenceWriteQueue.layer),
        Layer.provideMerge(frozen ? TestClock.layer() : Layer.empty)
      )
      const { runId, call } = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionStore
          const chat = yield* ChatWriteStore
          const session = yield* sessions.create({ name: "notes" })
          const run = yield* chat.start({
            sessionId: session.sessionId,
            clientId: "start",
            requestHash: "start",
            assistantMessageId: "answer",
            message: {
              message_id: "start",
              client_id: "start",
              role: ROLE.user,
              content: "Write it",
              created_at: new Date().toISOString()
            }
          })
          const call = {
            runId: run.runId,
            sessionId: session.sessionId,
            toolCallId: "write",
            toolName: "file_write",
            changesState: true,
            arguments: { path: "notes.md", content: "Findings" }
          }
          const tools = yield* ToolExecutionStore
          yield* tools.begin(call)
          yield* tools.pause(call, { reason: "approval", preview: "Create notes.md" })
          return { runId: run.runId, call }
        }).pipe(Effect.provide(layer))
      )
      const asked = cardOf(databasePath, runId)
      expect(asked).toMatchObject({ kind: "tool_approval", status: "pending" })
      await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* ToolExecutionStore
          yield* tools.resolve({ runId, toolCallId: "write", approved: true })
          yield* tools.begin(call)
          yield* tools.uncertain(call)
          yield* tools.requireOutcomeDecision({ runId, sessionId: call.sessionId })
        }).pipe(Effect.provide(layer))
      )
      const askedAgain = cardOf(databasePath, runId)
      expect(askedAgain).toMatchObject({ kind: "tool_outcome", status: "pending" })
      expect(askedAgain.requested_at > asked.requested_at).toBe(true)

      server = await startServerWithLocalAccess({
        port: 0,
        databasePath,
        modelHost,
        localAccess: access
      })
      const answer = (askedAt: string | undefined) =>
        server?.fetch("/tools/result", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_CAPABILITY_HEADER]: access.capability
          },
          body: JSON.stringify({
            run_id: runId,
            tool_id: "write",
            result: "",
            ...decisionBody(true, { askedAt, commandId: undefined })
          })
        })
      const phone = relayLoopback(
        { _tag: "TcpAddress", hostname: "127.0.0.1", port: server.port },
        access
      )
      const late = await runCommand(phone, "late-allow", {
        kind: "decide",
        args: { run_id: runId, tool_id: "write", approve: true, asked_at: asked.requested_at }
      })
      expect(late.state).toBe("rejected")
      expect(cardOf(databasePath, runId)).toMatchObject({ kind: "tool_outcome", status: "pending" })
      expect((await answer(asked.requested_at))?.status).toBe(409)
      expect(cardOf(databasePath, runId)).toMatchObject({ kind: "tool_outcome", status: "pending" })
      expect((await answer(askedAgain.requested_at))?.status).toBe(200)
      expect(cardOf(databasePath, runId)).toMatchObject({
        kind: "tool_outcome",
        status: "approved"
      })
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)
