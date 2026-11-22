import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { makeOnboardingStart } from "../src/chat/onboarding-start.js"
import { ChatMessageError } from "../src/chat/message-errors.js"
import type { ChatSendInput } from "../src/chat/message-input.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { startServer } from "../src/index.js"

const AT = "2026-11-22T00:00:00.000Z"

const markOf = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly mark: string | null }>`
      SELECT json_type(metadata, '$.onboarding.at') AS mark FROM sessions
      WHERE session_id = ${sessionId}`
    return rows[0]?.mark ?? undefined
  })

const mainSpace = Effect.gen(function* () {
  const main = (yield* (yield* SpaceStore).list()).find((space) => space.kind === "main")
  if (main === undefined) return yield* Effect.die("no Main Space")
  return main.space_id
})

it("Getting started resends its kickoff until one is admitted, and never after that", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const sql = yield* SqlClient.SqlClient
      const chat = yield* sessions.ensureSpaceConversation(yield* mainSpace)
      const sent: Array<string> = []
      const send = (input: ChatSendInput) =>
        Effect.gen(function* () {
          sent.push(input.clientId)
          if (sent.length === 1)
            return yield* new ChatMessageError({ reason: "unavailable", message: "Not now" })
          yield* sql`INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash,
              status, created_at, updated_at)
            VALUES (${input.sessionId}, ${input.clientId}, 'hash', 'accepted', ${AT}, ${AT})`.pipe(
            Effect.orDie
          )
        })
      const start = yield* makeOnboardingStart({ store: sessions, send })
      const failed = yield* start(chat).pipe(Effect.flip)
      const markAfterFailure = yield* markOf(chat)
      const retried = yield* start(chat)
      const again = yield* start(chat)
      yield* sessions.finishOnboarding(chat)
      const afterFinish = yield* start(chat)
      return {
        failed: failed.message,
        markAfterFailure,
        retried,
        again,
        afterFinish,
        markAfterFinish: yield* markOf(chat),
        sent: sent.map((clientId) => clientId === `onboarding:${chat}`)
      }
    })
  )
  expect(outcome).toEqual({
    failed: "Not now",
    markAfterFailure: "text",
    retried: true,
    again: false,
    afterFinish: false,
    markAfterFinish: undefined,
    sent: [true, true]
  })
})

it("Getting started runs only in an ordinary chat in Main", async () => {
  const refused = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const work = yield* spaces.create({ name: "Work" })
      const elsewhere = yield* sessions.create({ name: "Elsewhere", spaceId: work.space_id })
      const capture = yield* sessions.create({ name: "Capture", spaceId: main, origin: "capture" })
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, space_id, origin_automation_id, parent_session_id, parent_run_id,
          parent_tool_call_id)
        VALUES ('automation', 'automation', ${AT}, ${AT}, 'channel', ${main}, 'daily', NULL, NULL,
            NULL),
          ('agent', 'agent', ${AT}, ${AT}, 'agent', ${main}, NULL, ${capture.sessionId}, 'run',
            'call')`
      const reason = (sessionId: string) =>
        sessions.markOnboarding(sessionId).pipe(
          Effect.flip,
          Effect.map((error) => error.reason)
        )
      return {
        elsewhere: yield* reason(elsewhere.sessionId),
        capture: yield* reason(capture.sessionId),
        automation: yield* reason("automation"),
        agent: yield* reason("agent"),
        missing: yield* reason("no-such-chat")
      }
    })
  )
  expect(refused).toEqual({
    elsewhere: "conflict",
    capture: "conflict",
    automation: "conflict",
    agent: "conflict",
    missing: "not_found"
  })
})

it("Getting started is refused while the chat works, once it is archived, and gives one start to two calls at once", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const busy = yield* sessions.create({ name: "Busy", spaceId: main })
      const archived = yield* sessions.create({ name: "Old", spaceId: main })
      const fresh = yield* sessions.create({ name: "Fresh", spaceId: main })
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          metadata_json, assistant_message_id)
        VALUES ('working', ${busy.sessionId}, 'running', ${AT}, ${AT}, '{}', 'assistant-working')`
      yield* sql`UPDATE sessions SET archived_at = ${AT} WHERE session_id = ${archived.sessionId}`
      const refusal = (sessionId: string) =>
        sessions.markOnboarding(sessionId).pipe(
          Effect.flip,
          Effect.map((error) => [error.reason, error.message])
        )
      const send = (input: ChatSendInput) =>
        sql`INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash, status,
            created_at, updated_at)
          VALUES (${input.sessionId}, ${input.clientId}, 'hash', 'accepted', ${AT}, ${AT})`.pipe(
          Effect.orDie
        )
      const start = yield* makeOnboardingStart({ store: sessions, send })
      const both = yield* Effect.all([start(fresh.sessionId), start(fresh.sessionId)], {
        concurrency: "unbounded"
      })
      return {
        busy: yield* refusal(busy.sessionId),
        busyMark: yield* markOf(busy.sessionId),
        archived: yield* refusal(archived.sessionId),
        archivedMark: yield* markOf(archived.sessionId),
        both: both.toSorted()
      }
    })
  )
  expect(outcome).toEqual({
    busy: ["conflict", "This chat is busy; try again once it is idle"],
    busyMark: undefined,
    archived: ["conflict", "This chat is archived"],
    archivedMark: undefined,
    both: [false, true]
  })
})

it("the onboarding route answers 404 for an unknown chat and 409 with the reason outside Main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-onboarding-route-"))
  const server = await startServer({
    port: 0,
    databasePath: join(directory, "arden.db"),
    sharedSkillRoots: []
  })
  const headers = { "content-type": "application/json" }
  try {
    const space = await server.fetch("/spaces", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Work" })
    })
    const { space_id } = (await space.json()) as { readonly space_id: string }
    const chat = await server.fetch("/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ space_id })
    })
    const { session_id } = (await chat.json()) as { readonly session_id: string }
    const unknown = await server.fetch("/sessions/no-such-chat/onboarding", { method: "POST" })
    const outside = await server.fetch(`/sessions/${session_id}/onboarding`, { method: "POST" })
    expect([unknown.status, outside.status, await outside.json()]).toEqual([
      404,
      409,
      { detail: "Getting started runs only in an ordinary chat in the Main Space" }
    ])
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
