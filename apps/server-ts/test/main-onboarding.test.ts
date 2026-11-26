import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { makeOnboardingStart } from "../src/chat/onboarding-start.js"
import {
  makeInputMessage,
  onboardingKickoff,
  type ChatSendInput
} from "../src/chat/message-input.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { startServer } from "../src/index.js"
import { MODEL_PROVIDER_PROTOCOL, type ModelProvider } from "@arden-hq/loop"
import type { ModelHost } from "../src/models/host.js"

const AT = "2026-11-22T00:00:00.000Z"

const markOf = (sessionId: string) =>
  Effect.gen(function* () {
    return yield* (yield* SessionStore).onboardingKickedOff(sessionId)
  })

const mainSpace = Effect.gen(function* () {
  const main = (yield* (yield* SpaceStore).list()).find((space) => space.kind === "main")
  if (main === undefined) return yield* Effect.die("no Main Space")
  return main.space_id
})

const admitKickoff = (sessionId: string, opensOnboarding: boolean) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    const kickoff = onboardingKickoff(sessionId)
    return yield* chat
      .receive({
        sessionId,
        clientId: kickoff.clientId,
        requestHash: kickoff.clientId,
        assistantMessageId: `assistant-${sessionId}`,
        message: yield* makeInputMessage(kickoff),
        wake: true,
        ...(opensOnboarding ? { opensOnboarding: true as const } : {})
      })
      .pipe(
        Effect.map((result) => result._tag),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === "ChatWriteConflictError" ? error.message : `${error.reason}`
          )
        )
      )
  })

const ownerTurn = (sessionId: string, clientId: string) =>
  Effect.gen(function* () {
    const started = yield* (yield* ChatWriteStore).start({
      sessionId,
      clientId,
      requestHash: clientId,
      assistantMessageId: `assistant-${clientId}`,
      message: {
        message_id: clientId,
        client_id: clientId,
        role: ROLE.user,
        content: "Hi",
        created_at: AT
      }
    })
    if (started._tag !== "Started") return yield* Effect.die("the owner turn did not start")
    return started.runId
  })

it("the kickoff admission checks the chat and writes the mark in one step", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const fresh = yield* sessions.create({ name: "Fresh", spaceId: main })
      const busy = yield* sessions.create({ name: "Busy", spaceId: main })
      const archived = yield* sessions.create({ name: "Old", spaceId: main })
      const moved = yield* sessions.create({ name: "Moved", spaceId: main })
      const work = yield* spaces.create({ name: "Work", instructions: { kind: "unwritten" } })
      yield* ownerTurn(busy.sessionId, "turn-between")
      yield* sql`UPDATE sessions SET archived_at = ${AT} WHERE session_id = ${archived.sessionId}`
      yield* sessions.moveToSpace(moved.sessionId, work.space_id)
      const admitted = yield* admitKickoff(fresh.sessionId, true)
      const replayed = yield* admitKickoff(fresh.sessionId, true)
      return {
        admitted,
        replayed,
        freshMark: yield* markOf(fresh.sessionId),
        busy: yield* admitKickoff(busy.sessionId, true),
        busyMark: yield* markOf(busy.sessionId),
        archived: yield* admitKickoff(archived.sessionId, true),
        moved: yield* admitKickoff(moved.sessionId, true),
        missing: yield* admitKickoff("no-such-chat", true)
      }
    })
  )
  expect(outcome).toEqual({
    admitted: "Started",
    replayed: "Existing",
    freshMark: true,
    busy: expect.stringContaining("busy"),
    busyMark: false,
    archived: "not_found",
    moved: expect.stringContaining("Main"),
    missing: "not_found"
  })
})

it("the owner's start wakes a chat whose last run hit a lasting error, where a kickoff alone waits", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const failed = (name: string) =>
        Effect.gen(function* () {
          const chat = yield* sessions.create({ name, spaceId: main })
          const runId = yield* ownerTurn(chat.sessionId, `turn-${name}`)
          yield* sql`UPDATE chat_runs SET status = 'error', error_code = 'provider_auth',
              error_message = 'Sign in again', ended_at = ${AT}, updated_at = ${AT}, started_at = ${AT}
            WHERE run_id = ${runId}`
          return chat.sessionId
        })
      const started = yield* failed("Started")
      const waiting = yield* failed("Waiting")
      return {
        start: yield* admitKickoff(started, true),
        kickoffAlone: yield* admitKickoff(waiting, false)
      }
    })
  )
  expect(outcome).toEqual({ start: "Started", kickoffAlone: "Stored" })
})

it("two starts at once give one start, and a failed send can be retried", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const chat = yield* sessions.create({ name: "Fresh", spaceId: main })
      const sent: Array<boolean> = []
      const send = (input: ChatSendInput) =>
        Effect.gen(function* () {
          sent.push(input.opensOnboarding === true)
          if (sent.length === 1) return yield* Effect.fail(new Error("Not now"))
          yield* sql`INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash,
              status, created_at, updated_at)
            VALUES (${input.sessionId}, ${input.clientId}, 'hash', 'accepted', ${AT}, ${AT})`.pipe(
            Effect.orDie
          )
        }).pipe(Effect.orDie)
      const start = yield* makeOnboardingStart({ store: sessions, send })
      const failed = yield* start(chat.sessionId).pipe(Effect.exit)
      const both = yield* Effect.all([start(chat.sessionId), start(chat.sessionId)], {
        concurrency: "unbounded"
      })
      return { failed: failed._tag, both: both.toSorted(), sent }
    })
  )
  expect(outcome).toEqual({ failed: "Failure", both: [false, true], sent: [true, true] })
})

const provider: ModelProvider = {
  protocolVersion: MODEL_PROVIDER_PROTOCOL,
  capabilities: () => ({ hostedTools: [], structuredOutput: "native" }),
  stream: (request) => [
    {
      _tag: "Completed",
      message: {
        role: ROLE.assistant,
        content: "Welcome.",
        tool_calls: null,
        reasoning_content: null
      },
      finish_reason: "stop",
      usage: { prompt_tokens: 2, completion_tokens: 1 },
      model: request.model
    }
  ]
}

const modelHost: ModelHost = {
  models: [
    {
      id: "m",
      name: "m",
      provider: { id: "p", name: "P" },
      reasoningEfforts: [],
      context: { hardLimit: 32_768, compactionTrigger: 26_214 }
    }
  ],
  defaults: {
    chatModelId: "m",
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
}

it("the onboarding route starts once in Main, answers 404 for an unknown chat and 409 with the reason outside Main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-onboarding-route-"))
  const server = await startServer({
    port: 0,
    databasePath: join(directory, "arden.db"),
    provider,
    modelHost,
    sharedSkillRoots: [],
    memory: false
  })
  const headers = { "content-type": "application/json" }
  const post = async (path: string, body: unknown) =>
    (await server.fetch(path, { method: "POST", headers, body: JSON.stringify(body) })).json()
  const start = async (sessionId: string) => {
    const answer = await server.fetch(`/sessions/${sessionId}/onboarding`, { method: "POST" })
    return { status: answer.status, body: await answer.text() }
  }
  try {
    const spaces = (await (await server.fetch("/spaces")).json()) as {
      readonly spaces: ReadonlyArray<{ readonly space_id: string; readonly kind: string }>
    }
    const main = spaces.spaces.find((space) => space.kind === "main")?.space_id
    const work = (await post("/spaces", { name: "Work", instructions: { kind: "unwritten" } })) as {
      readonly space_id: string
    }
    const inMain = (await post("/sessions", { space_id: main })) as { readonly session_id: string }
    const outside = (await post("/sessions", { space_id: work.space_id })) as {
      readonly session_id: string
    }
    const first = await start(inMain.session_id)
    const unknown = await start("no-such-chat")
    const refused = await start(outside.session_id)
    expect([first.status, JSON.parse(first.body).started, unknown.status, refused.status]).toEqual([
      200,
      true,
      404,
      409
    ])
    expect(JSON.parse(refused.body).detail).toContain("Main")
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
