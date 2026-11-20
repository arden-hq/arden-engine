import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import type { StoredMessageEnvelope } from "../src/persistence/transcript/model.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-19T09:00:00.000Z"

const calls = (id: string, ...names: ReadonlyArray<string>): StoredMessageEnvelope => ({
  message_id: id,
  role: ROLE.assistant,
  created_at: AT,
  content: null,
  tool_calls: names.map((name, index) => ({
    id: `${id}-${index}`,
    type: "function",
    function: { name, arguments: "{}" }
  }))
})

const says = (id: string, content: string): StoredMessageEnvelope => ({
  message_id: id,
  role: ROLE.assistant,
  created_at: AT,
  content
})

it("says where each of a turn's tool calls sits, so a reader can tell which came before a reply", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const transcript = yield* TranscriptQueries
      const sessionId = (yield* sessions.create({})).sessionId
      const started = yield* chat.start({
        sessionId,
        clientId: "ask",
        requestHash: "ask",
        assistantMessageId: "answer",
        message: {
          message_id: "ask",
          client_id: "ask",
          role: ROLE.user,
          content: "ask",
          created_at: AT
        }
      })
      if (started._tag !== "Started") throw new Error(`Turn did not start: ${started._tag}`)
      yield* chat.finish({
        runId: started.runId,
        messages: [
          ...started.activeMessages,
          calls("first-work", "web_search", "web_fetch"),
          says("first-reply", "First findings."),
          calls("second-work", "web_search"),
          says("answer", "Done.")
        ]
      })
      const rows = yield* sql<{ readonly message_id: string; readonly seq: number }>`
        SELECT message_id, seq FROM session_messages WHERE session_id = ${sessionId}
      `
      const seq = new Map(rows.map((row) => [row.message_id, row.seq]))
      const counts = yield* transcript.toolCallCounts(sessionId, [started.turnId])
      return {
        counts: counts.get(started.turnId),
        first: seq.get("first-work"),
        reply: seq.get("first-reply"),
        second: seq.get("second-work")
      }
    })
  )
  const { first, reply, second } = read
  if (first === undefined || reply === undefined || second === undefined)
    throw new Error("A stored message has no seq")
  expect(first < reply && reply < second).toBe(true)
  expect(read.counts).toEqual([
    { name: "web_fetch", display_name: null, count: 1, rejected: 0, seqs: [first] },
    { name: "web_search", display_name: null, count: 2, rejected: 0, seqs: [first, second] }
  ])
})
