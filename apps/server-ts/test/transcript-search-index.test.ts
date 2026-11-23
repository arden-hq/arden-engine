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
import { transcriptSearchStep } from "../src/persistence/sqlite/search.js"
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

/** A chat with seven notes about the kettle, and no search database yet. */
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

it("finds messages by their current text and cuts snippets from arden.db", async () => {
  await withDirectory(async (directory) => {
    const filename = join(directory, "arden.db")
    const results = await openAt(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const sessions = yield* SessionStore
        const { sessionId } = yield* sessions.create({ name: "Deploys" })
        yield* say(sessionId, "m1", 1, "The staging cluster ran out of disk space.")
        yield* say(
          sessionId,
          "m2",
          2,
          `${"alpha ".repeat(10)}needle ${"omega ".repeat(40)}`.trimEnd()
        )
        const found = yield* search(sessionId, "staging")
        const syntax = yield* search(sessionId, '"disk space" OR stag* OR missing')
        const long = yield* search(sessionId, "needle")
        const replacement = {
          message_id: "m1",
          role: ROLE.assistant,
          content: "Rollout done.",
          created_at: AT
        }
        yield* sql`UPDATE session_messages
          SET message_json = ${JSON.stringify(replacement)},
              search_text = ${transcriptSearchText(replacement)}
          WHERE message_id = 'm1'`
        const afterEditOld = yield* search(sessionId, "staging")
        const afterEditNew = yield* search(sessionId, "rollout")
        yield* sql`DELETE FROM session_messages WHERE message_id = 'm1'`
        const afterDelete = yield* search(sessionId, "rollout")
        return {
          found,
          syntax,
          long,
          afterEditOld,
          afterEditNew,
          afterDelete
        }
      })
    )
    expect(results).toEqual({
      found: [["m1", "The [staging] cluster ran out of disk space."]],
      syntax: [["m1", "The [staging] cluster ran out of [disk] [space]."]],
      long: [["m2", `…alpha alpha alpha [needle] ${"omega ".repeat(22)}ome…`]],
      afterEditOld: [],
      afterEditNew: [["m1", "[Rollout] done."]],
      afterDelete: []
    })
  })
})

it("opens without filling a new index, and a search meanwhile returns what is indexed so far", async () => {
  await withDirectory(async (directory) => {
    const { filename, sessionId, sessionRef } = await kettleNotes(directory)
    const result = await openAt(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const persistence = yield* Persistence
        const atOpen = yield* searchState(sessionId, "kettle", sessionRef)
        // One background step of two messages, run on a second connection.
        yield* sql.unsafe("ATTACH DATABASE ? AS search", [searchFile(directory)])
        yield* transcriptSearchStep(sql, { rebuildBatchSize: 2 })
        const partway = yield* searchState(sessionId, "kettle", sessionRef)
        yield* persistence.fillSearchIndex
        return { atOpen, partway, filled: yield* searchState(sessionId, "kettle", sessionRef) }
      })
    )
    expect(result).toEqual({
      atOpen: { hits: [], indexing: true },
      partway: { hits: ["n1", "n2"], indexing: true },
      filled: { hits: ALL_NOTES, indexing: false }
    })
  })
})
