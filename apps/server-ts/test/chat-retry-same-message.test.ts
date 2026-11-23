import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ChatWriteStore, REQUEST_HASH_VERSION } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const send = (sessionId: string, clientId: string, requestHash: string, content: string) => ({
  sessionId,
  clientId,
  requestHash,
  assistantMessageId: `${clientId}-answer`,
  message: {
    message_id: clientId,
    client_id: clientId,
    role: "user" as const,
    content,
    created_at: "2026-11-20T09:00:00.000Z"
  }
})

it("a receipt fingerprinted by an older request format is matched by its client id", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const { sessionId } = yield* (yield* SessionStore).create({})
      const chat = yield* ChatWriteStore
      const sql = yield* SqlClient.SqlClient
      const first = yield* chat.start(
        send(sessionId, "old", "hash-before-upgrade", "Plan the trip")
      )
      yield* sql`UPDATE chat_idempotency_keys SET request_hash_version = ${REQUEST_HASH_VERSION - 1}
        WHERE client_id = 'old'`
      const retry = yield* chat.start(send(sessionId, "old", "hash-after-upgrade", "Plan the trip"))
      return retry.runId === first.runId
    })
  )
  expect(result).toBe(true)
})

it("a receipt fingerprinted by the current format refuses any other request under its client id", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const { sessionId } = yield* (yield* SessionStore).create({})
      const chat = yield* ChatWriteStore
      const first = yield* chat.start(send(sessionId, "new", "hash-safe", "Plan the trip"))
      const same = yield* chat.start(send(sessionId, "new", "hash-safe", "Plan the trip"))
      const changed = yield* chat
        .start(send(sessionId, "new", "hash-ask", "Plan the trip"))
        .pipe(Effect.flip)
      return { same: same.runId === first.runId, changed: changed._tag }
    })
  )
  expect(result).toEqual({ same: true, changed: "ChatWriteConflictError" })
})
