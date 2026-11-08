import { Effect } from "effect"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const startInput = (sessionId: string, clientId: string) => ({
  sessionId,
  clientId,
  requestHash: clientId,
  assistantMessageId: `${clientId}-answer`,
  fromQueue: true as const,
  message: {
    message_id: clientId,
    client_id: clientId,
    role: "user" as const,
    content: clientId,
    created_at: "2026-11-07T00:00:00.000Z"
  }
})

it("the queue's send claims only the head row, so a cancelled or overtaken turn is never sent and a sent one is not sent twice", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const { sessionId } = yield* sessions.create({ name: "Claimed queue" })
      for (const clientId of ["a", "b", "c"])
        yield* chat.enqueue({ sessionId, clientId, message: clientId, images: [] })

      const overtaken = yield* chat.start(startInput(sessionId, "b")).pipe(Effect.result)
      expect(overtaken).toMatchObject({ _tag: "Failure", failure: { kind: "queue_changed" } })
      expect((yield* chat.listQueued(sessionId)).map((m) => m.clientId)).toEqual(["a", "b", "c"])

      yield* chat.cancelQueued({ sessionId, clientId: "a" })
      const cancelled = yield* chat.start(startInput(sessionId, "a")).pipe(Effect.result)
      expect(cancelled).toMatchObject({ _tag: "Failure", failure: { kind: "queue_changed" } })

      const started = yield* chat.start(startInput(sessionId, "b"))
      expect(started._tag).toBe("Started")
      expect((yield* chat.listQueued(sessionId)).map((m) => m.clientId)).toEqual(["c"])
      const again = yield* chat.start(startInput(sessionId, "b"))
      expect(again).toMatchObject({ _tag: "Existing", runId: started.runId })

      const busy = yield* chat.start(startInput(sessionId, "c")).pipe(Effect.result)
      expect(busy).toMatchObject({ _tag: "Failure", failure: { kind: "session_busy" } })
      expect((yield* chat.listQueued(sessionId)).map((m) => m.clientId)).toEqual(["c"])
    })
  )
})
