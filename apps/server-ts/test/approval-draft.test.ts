import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

const draft = { kind: "draft" as const, offeredBy: (toolName: string) => toolName === "email_send" }
const asked = {
  account_ref: "me@example.com",
  recipient: "tom@example.com",
  subject: "Hi",
  body: "Hello"
}

describe("Save as draft on an approval card", () => {
  it("records one draft decision, replays it on resume, and never as a rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-approval-draft-"))
    const layer = sqlitePersistenceLayer({
      dataDir: null,
      filename: join(directory, "arden.db")
    }).pipe(Layer.provide(PersistenceWriteQueue.layer))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionStore
          const chat = yield* ChatWriteStore
          const tools = yield* ToolExecutionStore
          const session = yield* sessions.create({ name: "Drafts" })
          const started = yield* chat.start({
            sessionId: session.sessionId,
            clientId: "start",
            requestHash: "start",
            assistantMessageId: "assistant",
            message: {
              message_id: "start",
              client_id: "start",
              role: "user",
              content: "Write to Tom",
              created_at: new Date().toISOString()
            }
          })
          const call = (toolCallId: string, toolName: string) => ({
            runId: started.runId,
            sessionId: session.sessionId,
            toolCallId,
            toolName,
            changesState: false,
            arguments: asked
          })
          for (const [id, name] of [
            ["drafted", "email_send"],
            ["sent", "email_send"],
            ["other", "file_write"]
          ] as const) {
            yield* tools.begin(call(id, name))
            yield* tools.pause(call(id, name), { reason: "approval", preview: "Send" })
          }
          const resolve = (toolCallId: string, extra: object) =>
            tools.resolve({ runId: started.runId, toolCallId, ...extra })

          for (const refused of [
            resolve("drafted", { approved: false, alternative: draft }),
            resolve("drafted", { approved: true, grantStanding: true, alternative: draft }),
            resolve("other", { approved: true, alternative: draft })
          ]) {
            expect((yield* Effect.flip(refused)).reason).toBe("invalid")
          }

          yield* resolve("drafted", { approved: true, alternative: draft })
          yield* resolve("drafted", { approved: true, alternative: draft })
          expect((yield* Effect.flip(resolve("drafted", { approved: true }))).reason).toBe(
            "conflict"
          )
          yield* resolve("sent", { approved: true })

          expect(yield* tools.begin(call("drafted", "email_send"))).toEqual({
            _tag: "Started",
            approval: { approved: true, feedback: null, alternative: "draft" }
          })
          expect(yield* tools.begin(call("sent", "email_send"))).toEqual({
            _tag: "Started",
            approval: { approved: true, feedback: null }
          })
          expect(yield* resolve("drafted", { approved: true, alternative: draft })).toEqual({
            runId: started.runId,
            ready: false
          })
          expect((yield* Effect.flip(tools.begin(call("drafted", "email_send")))).reason).toBe(
            "conflict"
          )
        }).pipe(Effect.provide(layer))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
