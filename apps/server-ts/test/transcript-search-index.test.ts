import { ROLE } from "@arden-hq/std/message-vocabulary"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { searchSchemaSection } from "../src/persistence/schema/search.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import type { SqlitePersistence } from "../src/persistence/sqlite/layer.js"
import {
  initializeSearchIndex,
  refillTranscriptSearch,
  transcriptSearchStep
} from "../src/persistence/sqlite/search.js"
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
        const index = new DatabaseSync(searchFile(directory), { readOnly: true })
        const stored = index
          .prepare("SELECT rowid, search_text FROM session_messages_fts ORDER BY rowid")
          .all()
          .map((row) => ({ ...row }))
        const shadow = index
          .prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'session_messages_fts_*'")
          .all()
          .map((row) => String(row.name))
          .toSorted()
        index.close()
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
          stored,
          shadow,
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
      // The index keeps words only: its column reads as NULL and it has no content table.
      stored: [
        { rowid: 1, search_text: null },
        { rowid: 2, search_text: null }
      ],
      shadow: [
        "session_messages_fts_config",
        "session_messages_fts_data",
        "session_messages_fts_docsize",
        "session_messages_fts_idx"
      ],
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

it("resumes a fill that stopped partway, without indexing a message twice", async () => {
  await withDirectory(async (directory) => {
    const { filename, sessionId, sessionRef } = await kettleNotes(directory)
    // A search database whose fill fails after its first chunk, the way a
    // stopped app leaves it.
    const fresh = new DatabaseSync(":memory:")
    fresh.exec(`ATTACH DATABASE '${searchFile(directory)}' AS search`)
    for (const statement of searchSchemaSection.statements) fresh.exec(statement)
    fresh.exec(`PRAGMA search.user_version = ${searchSchemaSection.version}`)
    fresh.exec(`CREATE TRIGGER search.stop_rebuild BEFORE UPDATE ON transcript_rebuild
      WHEN NEW.after_rowid > 3 BEGIN SELECT RAISE(ABORT, 'stopped'); END`)
    fresh.close()

    const stopped = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* initializeSearchIndex(sql, filename)
          yield* refillTranscriptSearch(sql, { rebuildBatchSize: 3 })
        }).pipe(Effect.provide(SqliteClient.layer({ filename })))
      )
    )
    expect(stopped._tag).toBe("Failure")
    const partial = new DatabaseSync(searchFile(directory), { readOnly: true })
    expect({
      position: partial.prepare("SELECT after_rowid FROM transcript_rebuild").all().map(plain),
      indexed: partial.prepare("SELECT rowid FROM session_messages_fts").all().map(plain)
    }).toEqual({
      position: [{ after_rowid: 3 }],
      indexed: [{ rowid: 1 }, { rowid: 2 }, { rowid: 3 }]
    })
    partial.close()
    const repaired = new DatabaseSync(searchFile(directory))
    repaired.exec("DROP TRIGGER stop_rebuild")
    repaired.close()

    const filled = await openAt(
      filename,
      Effect.gen(function* () {
        const persistence = yield* Persistence
        yield* persistence.fillSearchIndex
        return yield* searchState(sessionId, "kettle", sessionRef)
      })
    )
    expect(filled).toEqual({ hits: ALL_NOTES, indexing: false })
    const done = new DatabaseSync(searchFile(directory), { readOnly: true })
    expect({
      position: done.prepare("SELECT after_rowid FROM transcript_rebuild").all().map(plain),
      indexed: done.prepare("SELECT count(*) AS n FROM session_messages_fts").all().map(plain)
    }).toEqual({ position: [], indexed: [{ n: 7 }] })
    done.close()
  })
})

it("upgrades a version 3 index in place at open, keeps the embeddings, and fills it after", async () => {
  await withDirectory(async (directory) => {
    const filename = join(directory, "arden.db")
    const sessionId = await openAt(
      filename,
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const session = yield* sessions.create({ name: "Garden" })
        yield* say(session.sessionId, "g1", 1, "Tomatoes need staking in June.")
        return session.sessionId
      })
    )
    const old = new DatabaseSync(searchFile(directory))
    old.exec("DROP TABLE session_messages_fts")
    old.exec("DROP TABLE transcript_rebuild")
    old.exec(`CREATE VIRTUAL TABLE session_messages_fts USING fts5(
      search_text, tokenize='unicode61 remove_diacritics 2')`)
    old.exec("INSERT INTO session_messages_fts(rowid, search_text) VALUES (1, 'stale words')")
    old.exec(`INSERT INTO wiki_embedding_indexes (index_version, model_id, dimensions, role, started_at)
      VALUES ('granite@2', 'granite', 1, 'serving', 'now')`)
    old.exec(`INSERT INTO wiki_embedding_pages (index_version, page_id, page_version)
      VALUES ('granite@2', 'garden', 'p1')`)
    old.exec(`INSERT INTO wiki_embedding_chunks (index_version, page_id, chunk_index, chunk_text, embedding)
      VALUES ('granite@2', 'garden', 0, 'Tomatoes', x'00000000')`)
    old.exec("PRAGMA user_version = 3")
    old.close()

    const hits = await openAt(
      filename,
      Effect.gen(function* () {
        const persistence = yield* Persistence
        const atOpen = yield* search(sessionId, "tomatoes")
        yield* persistence.fillSearchIndex
        return {
          atOpen,
          filled: yield* Effect.all([search(sessionId, "tomatoes"), search(sessionId, "stale")])
        }
      })
    )
    expect(hits).toEqual({
      atOpen: [],
      filled: [[["g1", "[Tomatoes] need staking in June."]], []]
    })
    const upgraded = new DatabaseSync(searchFile(directory), { readOnly: true })
    expect({
      version: upgraded.prepare("PRAGMA user_version").all().map(plain),
      content: upgraded
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_messages_fts_content'")
        .all(),
      chunks: upgraded
        .prepare("SELECT page_id, chunk_text FROM wiki_embedding_chunks")
        .all()
        .map(plain)
    }).toEqual({
      version: [{ user_version: searchSchemaSection.version }],
      content: [],
      chunks: [{ page_id: "garden", chunk_text: "Tomatoes" }]
    })
    upgraded.close()
  })
})

const plain = (row: object) => ({ ...row })

// A changed message used to wait in the change list until the next search or
// the next launch, and the launch then applied the whole backlog in large
// writes. The engine now applies changes as it runs.
it("applies message changes to the index while running, with no search and no restart", async () => {
  await withDirectory(async (directory) => {
    const { filename, sessionId } = await kettleNotes(directory)
    process.env["ARDEN_TIMERS_AT_ONCE"] = "1"
    try {
      const pending = await openAt(
        filename,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const persistence = yield* Persistence
          const waiting = sql<{ readonly rows: number }>`
            SELECT COUNT(*) AS rows FROM transcript_search_changes`.pipe(
            Effect.map((rows) => rows[0]?.rows ?? -1)
          )
          yield* Effect.forkScoped(persistence.keepSearchIndexCurrent)
          yield* Effect.sleep("1 second")
          const settled = yield* waiting
          for (const seq of [8, 9, 10]) yield* say(sessionId, `n${seq}`, seq, `Late note ${seq}.`)
          const before = yield* waiting
          yield* Effect.sleep("2 seconds")
          return { settled, before, after: yield* waiting }
        }).pipe(Effect.scoped)
      )
      expect(pending).toEqual({ settled: 0, before: 3, after: 0 })
    } finally {
      delete process.env["ARDEN_TIMERS_AT_ONCE"]
    }
  })
})
