import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
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
    role: ROLE.user,
    content,
    created_at: AT
  }
})

it("retries a queued or admitted message idempotently, and the chat name seed survives clearing the transcript", async () => {
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
        retryFirst: yield* chat.start(first),
        retrySecond: yield* chat.start(second),
        pending: yield* chat.peekPendingInput(started.runId),
        nameSeed: yield* queries.loadNameSeed(sessionId)
      }
      const drained = yield* chat.drainPending(started.runId)
      const afterDrain = {
        retrySecond: yield* chat.start(second),
        nameSeed: yield* queries.loadNameSeed(sessionId)
      }
      yield* chat.cancel({ runId: started.runId })
      yield* sessions.clear(sessionId)
      const afterClear = { nameSeed: yield* queries.loadNameSeed(sessionId) }
      return { started, queued, whileQueued, drained, afterDrain, afterClear }
    })
  )
  expect(result).toEqual({
    started: expect.objectContaining({ _tag: "Started" }),
    queued: { _tag: "Queued", runId: result.started.runId },
    whileQueued: {
      retryFirst: { _tag: "Existing", runId: result.started.runId, status: "running" },
      retrySecond: { _tag: "Existing", runId: result.started.runId, status: "queued" },
      pending: true,
      nameSeed: { text: "Plan the pantry shelves", images: [] }
    },
    drained: [
      expect.objectContaining({ message_id: "second", client_id: "second", role: ROLE.user })
    ],
    afterDrain: {
      retrySecond: { _tag: "Existing", runId: result.started.runId, status: "ingested" },
      nameSeed: { text: "Plan the pantry shelves", images: [] }
    },
    afterClear: { nameSeed: { text: "Plan the pantry shelves", images: [] } }
  })
})
