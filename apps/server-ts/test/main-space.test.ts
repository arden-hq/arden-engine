import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { seesEveryChat } from "../src/tools/session-browse-scope.js"
import { makeSessionTriage, makeSessionTriageAction } from "../src/assist/session-triage.js"
import { appendMessagesInTransaction } from "../src/persistence/sqlite/chat-transcript.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-20T00:00:00.000Z"

const mainSpace = Effect.gen(function* () {
  const spaces = yield* SpaceStore
  const listed = yield* spaces.list()
  const main = listed.find((space) => space.kind === "main")
  if (main === undefined) return yield* Effect.die("no Main Space")
  return main
})

const spaceOf = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly space_id: string | null }>`
      SELECT space_id FROM sessions WHERE session_id = ${sessionId}`
    return rows[0]?.space_id
  })

it("a new database has one Main Space; it lists first and cannot be archived", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const spaces = yield* SpaceStore
      const work = yield* spaces.create({ name: "Work" })
      const listed = yield* spaces.list()
      expect(listed.map((space) => [space.name, space.kind])).toEqual([
        ["Main", "main"],
        ["Work", "ordinary"]
      ])
      const main = yield* mainSpace
      const overview = yield* spaces.overview()
      expect(overview.spaces.map((space) => [space.title, space.kind])).toEqual([
        ["Main", "main"],
        ["Work", "ordinary"]
      ])
      const refused = yield* spaces.archive(main.space_id).pipe(Effect.flip)
      expect(refused).toMatchObject({
        reason: "conflict",
        message: "The Main Space cannot be archived."
      })
      expect(yield* spaces.archive(work.space_id)).toMatchObject({ status: "archived" })
      expect((yield* spaces.list()).map((space) => space.name)).toEqual(["Main"])
    })
  )
})

it("a chat made, moved or branched with no Space lands in Main and sees every Space's chats", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const work = yield* spaces.create({ name: "Work" })

      const loose = yield* sessions.create({ name: "Loose" })
      const capture = yield* sessions.create({ origin: "capture" })
      expect([loose.spaceId, capture.spaceId]).toEqual([main.space_id, main.space_id])

      const filed = yield* sessions.create({ name: "Filed", spaceId: work.space_id })
      expect(yield* sessions.moveToSpace(filed.sessionId, undefined)).toBe(true)
      expect(yield* spaceOf(filed.sessionId)).toBe(main.space_id)

      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, origin_automation_id, context_from_seq)
        VALUES ('automation-chat', 'automation-chat', ${AT}, ${AT}, 'channel', 'daily', 0)`
      const kept = yield* sessions.branch("automation-chat", { disposition: "retained" })
      const side = yield* sessions.branch("automation-chat", { disposition: "disposable" })
      expect([
        yield* spaceOf(kept?.sessionId ?? ""),
        yield* spaceOf(side?.sessionId ?? "")
      ]).toEqual([main.space_id, main.space_id])

      const inMain = yield* queries.loadHistoryHeader(loose.sessionId)
      const inWork = yield* queries.loadHistoryHeader(
        (yield* sessions.create({ spaceId: work.space_id })).sessionId
      )
      expect([inMain?.spaceKind, inWork?.spaceKind]).toEqual(["main", "ordinary"])
      expect([inMain, inWork].map((header) => header !== null && seesEveryChat(header))).toEqual([
        true,
        false
      ])

      const listed = yield* sessions.list({ inbox: true, scope: "primary" })
      expect(listed.map((entry) => entry.sessionId).toSorted()).toEqual(
        [loose.sessionId, capture.sessionId, filed.sessionId, kept?.sessionId].toSorted()
      )
    })
  )
})

it("triage files a chat from Main into another Space and undo brings it back to Main", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const work = yield* spaces.create({ name: "Work" })
      const chat = yield* sessions.create({ name: "Invoices" })
      yield* appendMessagesInTransaction(
        sql,
        chat.sessionId,
        [
          { message_id: "ask", role: ROLE.user, content: "Send the invoice", created_at: AT },
          { message_id: "answer", role: ROLE.assistant, content: "Sent it.", created_at: AT }
        ],
        AT,
        "post",
        "ask"
      )
      const offered: Array<unknown> = []
      const dependencies = {
        completion: {
          runTool: <S extends Schema.ConstraintDecoder<unknown>>(request: {
            readonly user: string
            readonly result: { readonly schema: S }
          }) => {
            offered.push(JSON.parse(request.user).spaces)
            return Schema.decodeUnknownEffect(request.result.schema)({
              decision: "move",
              target: { space_id: work.space_id, title: "Work" },
              new_title: null,
              confident: true,
              rationale: "About work"
            }).pipe(Effect.orDie)
          }
        },
        sessions: queries,
        spaces,
        wiki: { ensureSpacePage: () => Effect.die("no Memory in this test") },
        store: sessions
      }
      yield* makeSessionTriage(dependencies)(chat.sessionId)
      expect(offered).toEqual([[{ space_id: work.space_id, title: "Work" }]])
      expect(yield* spaceOf(chat.sessionId)).toBe(work.space_id)
      yield* makeSessionTriageAction(dependencies)(chat.sessionId, "undo")
      expect(yield* spaceOf(chat.sessionId)).toBe(main.space_id)
    })
  )
})
