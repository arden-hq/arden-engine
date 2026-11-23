import { ROLE } from "@arden-hq/std/message-vocabulary"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionStore } from "../src/persistence/sessions/store.js"
import type { SqlitePersistence } from "../src/persistence/sqlite/layer.js"
import { appendMessagesInTransaction } from "../src/persistence/sqlite/chat-transcript.js"
import { Persistence } from "../src/persistence/service.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { transcriptSearchText } from "../src/persistence/transcript/search-text.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

const AT = "2026-11-12T09:00:00.000Z"

const openAt = <A, E>(
  filename: string,
  body: Effect.Effect<A, E, SqlitePersistence | SqlClient.SqlClient>
): Promise<A> =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        Layer.merge(
          sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
            Layer.provide(PersistenceWriteQueue.layer)
          ),
          SqliteClient.layer({ filename })
        )
      )
    )
  )

const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-search-index-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const say = Effect.fn("say")(function* (
  sessionId: string,
  messageId: string,
  seq: number,
  content: string
) {
  const sql = yield* SqlClient.SqlClient
  const message = { message_id: messageId, role: ROLE.assistant, content, created_at: AT }
  yield* sql`INSERT INTO session_messages (
      session_id, message_id, seq, role, message_json, created_at, search_text
    ) VALUES (
      ${sessionId}, ${messageId}, ${seq}, 'assistant', ${JSON.stringify(message)}, ${AT},
      ${transcriptSearchText(message)}
    )`
})

const search = Effect.fn("search")(function* (
  requestingSessionId: string,
  query: string,
  scope: { readonly sessionRef?: string } = {}
) {
  const transcript = yield* TranscriptQueries
  const page = yield* transcript.search({
    requestingSessionId,
    query,
    limit: 10,
    offset: 0,
    ...scope
  })
  return page.hits.map((hit) => [hit.messageId, hit.snippet])
})

const searchState = Effect.fn("searchState")(function* (
  requestingSessionId: string,
  query: string,
  sessionRef: string
) {
  const transcript = yield* TranscriptQueries
  const page = yield* transcript.search({
    requestingSessionId,
    query,
    limit: 10,
    offset: 0,
    sessionRef
  })
  return { hits: page.hits.map((hit) => hit.messageId).toSorted(), indexing: page.indexing }
})

const kettleNotes = async (directory: string) => {
  const filename = join(directory, "arden.db")
  const chat = await openAt(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* SessionStore
      const session = yield* sessions.create({ name: "Notes" })
      for (const seq of [1, 2, 3, 4, 5, 6, 7])
        yield* say(session.sessionId, `n${seq}`, seq, `Note ${seq} about the kettle.`)
      const refs = yield* sql<{ readonly public_ref: string }>`
        SELECT public_ref FROM sessions WHERE session_id = ${session.sessionId}`
      return { sessionId: session.sessionId, sessionRef: refs[0]?.public_ref ?? "" }
    })
  )
  for (const suffix of ["", "-wal", "-shm"])
    await rm(`${searchFile(directory)}${suffix}`, { force: true })
  return { filename, ...chat }
}

const ALL_NOTES = ["n1", "n2", "n3", "n4", "n5", "n6", "n7"]

const searchFile = (directory: string) => join(directory, "search.sqlite")

it("finds messages by their text and cuts snippets, and forgets a deleted chat", async () => {
  await withDirectory(async (directory) => {
    const filename = join(directory, "arden.db")
    const results = await openAt(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const sessions = yield* SessionStore
        const { sessionId } = yield* sessions.create({ name: "Deploys" })
        const asker = yield* sessions.create({ name: "Asker" })
        yield* appendMessagesInTransaction(
          sql,
          sessionId,
          [
            {
              message_id: "m1",
              role: ROLE.assistant,
              content: "The staging cluster ran out of disk space.",
              created_at: AT
            },
            {
              message_id: "m2",
              role: ROLE.assistant,
              content: `${"alpha ".repeat(10)}needle ${"omega ".repeat(40)}`.trimEnd(),
              created_at: AT
            }
          ],
          AT,
          "post",
          "turn"
        )
        const found = yield* search(asker.sessionId, "staging")
        const syntax = yield* search(asker.sessionId, '"disk space" OR stag* OR missing')
        const long = yield* search(asker.sessionId, "needle")
        yield* sessions.archive(sessionId)
        yield* sessions.permanentDelete(sessionId)
        const afterDelete = yield* search(asker.sessionId, "staging")
        return { found, syntax, long, afterDelete }
      })
    )
    expect(results).toEqual({
      found: [["m1", "The [staging] cluster ran out of disk space."]],
      syntax: [["m1", "The [staging] cluster ran out of [disk] [space]."]],
      long: [["m2", `…alpha alpha alpha [needle] ${"omega ".repeat(22)}ome…`]],
      afterDelete: []
    })
  })
})

it("opens without filling a new index, and a search meanwhile says it is still indexing", async () => {
  await withDirectory(async (directory) => {
    const { filename, sessionId, sessionRef } = await kettleNotes(directory)
    const result = await openAt(
      filename,
      Effect.gen(function* () {
        const persistence = yield* Persistence
        const atOpen = yield* searchState(sessionId, "kettle", sessionRef)
        yield* persistence.fillSearchIndex
        return { atOpen, filled: yield* searchState(sessionId, "kettle", sessionRef) }
      })
    )
    expect(result).toEqual({
      atOpen: { hits: [], indexing: true },
      filled: { hits: ALL_NOTES, indexing: false }
    })
  })
})
