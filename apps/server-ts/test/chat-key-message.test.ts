import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { keyMessageCopiesBackfill } from "../src/persistence/sqlite/key-message-copies-backfill.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-12T09:00:00.000Z"

const input = (sessionId: string, clientId: string, content: string) => ({
  sessionId,
  clientId,
  requestHash: `${clientId}-request`,
  assistantMessageId: `${clientId}-answer`,
  message: {
    message_id: clientId,
    client_id: clientId,
    role: "user" as const,
    content,
    created_at: AT
  }
})

const copies = Effect.fn("copies")(function* (sessionId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly client_id: string; readonly copy: number }>`
    SELECT client_id, message_json IS NOT NULL AS copy FROM chat_idempotency_keys
    WHERE session_id = ${sessionId} ORDER BY client_id`
  return Object.fromEntries(rows.map((row) => [row.client_id, row.copy === 1]))
})

it("keeps an admitted message once: on its key until it is in the transcript, then only there", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const queries = yield* SessionQueries
      const { sessionId } = yield* sessions.create({})
      const first = input(sessionId, "first", "Plan the pantry shelves")
      const second = input(sessionId, "second", "Add a spice rack")
      const started = yield* chat.start(first)
      const queued = yield* chat.start(second)
      const whileQueued = {
        copies: yield* copies(sessionId),
        retryFirst: yield* chat.start(first),
        retrySecond: yield* chat.start(second),
        pending: yield* chat.peekPendingInput(started.runId),
        nameSeed: yield* queries.loadNameSeed(sessionId)
      }
      const drained = yield* chat.drainPending(started.runId)
      const afterDrain = {
        copies: yield* copies(sessionId),
        retrySecond: yield* chat.start(second),
        nameSeed: yield* queries.loadNameSeed(sessionId)
      }
      return { started, queued, whileQueued, drained, afterDrain }
    })
  )
  expect(result).toEqual({
    started: expect.objectContaining({ _tag: "Started" }),
    queued: { _tag: "Queued", runId: result.started.runId },
    whileQueued: {
      copies: { first: false, second: true },
      retryFirst: { _tag: "Existing", runId: result.started.runId, status: "running" },
      retrySecond: { _tag: "Existing", runId: result.started.runId, status: "queued" },
      pending: true,
      nameSeed: { text: "Plan the pantry shelves", images: [] }
    },
    drained: [expect.objectContaining({ message_id: "second", client_id: "second", role: "user" })],
    afterDrain: {
      copies: { first: false, second: false },
      retrySecond: { _tag: "Existing", runId: result.started.runId, status: "ingested" },
      nameSeed: { text: "Plan the pantry shelves", images: [] }
    }
  })
})

it("gives keys their message back when the transcript is cleared", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const queries = yield* SessionQueries
      const { sessionId } = yield* sessions.create({})
      const started = yield* chat.start(input(sessionId, "first", "Plan the pantry shelves"))
      yield* chat.cancel({ runId: started.runId })
      const before = yield* copies(sessionId)
      yield* sessions.clear(sessionId)
      const stored = yield* sql<{ readonly content: string }>`
        SELECT json_extract(message_json, '$.content') AS content FROM chat_idempotency_keys
        WHERE session_id = ${sessionId}`
      return {
        before,
        after: yield* copies(sessionId),
        stored,
        seed: yield* queries.loadNameSeed(sessionId)
      }
    })
  )
  expect(result).toEqual({
    before: { first: false },
    after: { first: true },
    stored: [{ content: "Plan the pantry shelves" }],
    seed: { text: "Plan the pantry shelves", images: [] }
  })
})

it("backfills in chunks, once, and leaves keys whose message is not in the transcript", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* SessionStore
      const { sessionId } = yield* sessions.create({})
      // Keys written before copies were dropped: k1–k4 have their message in the
      // transcript, k5 does not (input still queued).
      for (const [seq, id] of ["k1", "k2", "k3", "k4"].entries()) {
        const json = JSON.stringify({
          message_id: id,
          client_id: id,
          role: "user",
          content: id,
          created_at: AT
        })
        yield* sql`INSERT INTO session_messages (session_id, message_id, seq, role, message_json, client_id, created_at)
          VALUES (${sessionId}, ${id}, ${seq}, 'user', ${json}, ${id}, ${AT})`
      }
      for (const id of ["k1", "k2", "k3", "k4", "k5"]) {
        const json = JSON.stringify({
          message_id: id,
          client_id: id,
          role: "user",
          content: id,
          created_at: AT
        })
        yield* sql`INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash, message_id,
            message_json, status, created_at, updated_at)
          VALUES (${sessionId}, ${id}, ${id}, ${id}, ${json}, 'accepted', ${AT}, ${AT})`
      }
      const run = Effect.fn("run")(function* () {
        const steps: Array<{ readonly converted: number; readonly next: string | undefined }> = []
        let cursor: string | undefined
        do {
          const step = yield* keyMessageCopiesBackfill.chunk({ cursor, limit: 2 })
          steps.push(step)
          cursor = step.next
        } while (cursor !== undefined)
        return steps.map((step) => step.converted)
      })
      return { first: yield* run(), again: yield* run(), copies: yield* copies(sessionId) }
    })
  )
  expect(result).toEqual({
    first: [2, 2, 0],
    again: [0, 0, 0],
    copies: { k1: false, k2: false, k3: false, k4: false, k5: true }
  })
})
