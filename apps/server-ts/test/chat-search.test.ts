import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { visibleText } from "../src/persistence/sqlite/find-snippet.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { transcriptSearchText } from "../src/persistence/transcript/search-text.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-11T10:00:00.000Z"

const searchScenario = Effect.fn("searchScenario")(function* (query: string, limit = 20) {
  const sql = yield* SqlClient.SqlClient
  const sessions = yield* SessionStore
  const transcript = yield* TranscriptQueries
  let seq = 0
  const say = Effect.fn("say")(function* (sessionId: string, messageId: string, content: string) {
    seq += 1
    const message = { message_id: messageId, role: "assistant" as const, content, created_at: AT }
    yield* sql`INSERT INTO session_messages (
      session_id, message_id, seq, role, message_json, created_at, search_text
    ) VALUES (
      ${sessionId}, ${messageId}, ${seq}, 'assistant', ${JSON.stringify(message)}, ${AT},
      ${transcriptSearchText(message)}
    )`
  })
  const named = yield* sessions.create({ name: "Desk setup" })
  // "desk" inside a word is no match, as in the message index.
  yield* sessions.create({ name: "Undesked notes" })
  const long = yield* sessions.create({ name: "Speech research" })
  const linked = yield* sessions.create({ name: "Lab" })
  const accented = yield* sessions.create({ name: "Plans" })
  yield* say(named.sessionId, "named-1", "Standing or sitting?")
  for (const index of [1, 2, 3, 4, 5])
    yield* say(long.sessionId, `long-${index}`, `The desktop app, take ${index}.`)
  yield* say(linked.sessionId, "code", "```\n[test](arden:desk/abc)\n```")
  // Newer than "code": the chat must still show "code", whose link the chat draws.
  yield* say(linked.sessionId, "link", "Check [test](arden:desk/4521508e).")
  yield* say(accented.sessionId, "cafe", "Meet at the café near the station.")
  return {
    ids: {
      named: named.sessionId,
      long: long.sessionId,
      linked: linked.sessionId,
      accented: accented.sessionId
    },
    page: yield* transcript.searchChats({ query, limit })
  }
})

it("lists each chat once: name matches first, then the newest message match the chat draws", async () => {
  const { ids, page } = await withTempDatabase(searchScenario("desk"))
  expect(page).toEqual({
    chats: [
      {
        sessionId: ids.named,
        sessionName: "Desk setup",
        nameRanges: [[0, 4]],
        lastActivity: expect.any(String),
        match: "name",
        preview: {
          messageId: "named-1",
          createdAt: AT,
          snippet: "Standing or sitting?",
          ranges: []
        }
      },
      {
        sessionId: ids.linked,
        sessionName: "Lab",
        nameRanges: [],
        lastActivity: expect.any(String),
        match: "message",
        hit: {
          messageId: "code",
          createdAt: AT,
          snippet: "[test](arden:desk/abc)",
          ranges: [[13, 17]]
        }
      },
      {
        sessionId: ids.long,
        sessionName: "Speech research",
        nameRanges: [],
        lastActivity: expect.any(String),
        match: "message",
        hit: {
          messageId: "long-5",
          createdAt: AT,
          snippet: "The desktop app, take 5.",
          ranges: [[4, 8]]
        }
      }
    ],
    hasMore: false
  })
})

it("says there are more chats past the limit", async () => {
  const { page } = await withTempDatabase(searchScenario("desk", 1))
  expect(page.chats.map((chat) => [chat.sessionName, chat.match])).toEqual([
    ["Desk setup", "name"],
    ["Lab", "message"]
  ])
  expect(page.hasMore).toBe(true)
})

it("needs every word of the query, the last one as a word start", async () => {
  const { ids, page } = await withTempDatabase(searchScenario("app des"))
  expect(
    page.chats.map((chat) => [chat.sessionId, chat.match === "message" ? chat.hit.ranges : []])
  ).toEqual([
    [
      ids.long,
      [
        [4, 7],
        [12, 15]
      ]
    ]
  ])
})

it("ignores accents, as the index does", async () => {
  const { ids, page } = await withTempDatabase(searchScenario("cafe"))
  expect(
    page.chats.map((chat) => [chat.sessionId, chat.match === "message" ? chat.hit.ranges : []])
  ).toEqual([[ids.accented, [[12, 16]]]])
})

it("keeps only the text a chat draws", () => {
  expect(
    visibleText(
      [
        "See [the doc](https://x.dev/a) and ![chart](c.png).",
        "Run `[raw](kept)` as is.",
        "~~~\n[fenced](kept)\n~~~"
      ].join("\n")
    )
  ).toBe(["See the doc and .", "Run `[raw](kept)` as is.", "~~~\n[fenced](kept)\n~~~"].join("\n"))
})
