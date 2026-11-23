import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { dirname, join } from "node:path"
import { searchSchemaSection, searchSchemaUpgrades } from "../schema/search.js"
import { timerSleep } from "../../lib/timer-sleep.js"
import { pauseBetweenBatches, runIsActive } from "./background-pause.js"
import type { Writer } from "./deps.js"

/** Changed messages applied to the index per write. Each costs three
 * statements, so 100 keeps one write near a quarter second; 500 held the
 * single writer for one to two and a half seconds. */
const CHANGE_BATCH_SIZE = 100
/** How often the engine looks for changes the index has not applied yet. */
const KEEP_CURRENT_EVERY = "2 seconds"
/** Messages copied into the index per transaction while it is rebuilt. */
const REBUILD_BATCH_SIZE = 2_000

interface SearchIndexOptions {
  readonly searchFilename?: string
}

interface SearchClockRow {
  readonly head_sequence: number
}
interface SearchCursorRow {
  readonly applied_sequence: number
  readonly source_id: string
}
interface SearchChangeRow {
  readonly sequence: number
  readonly message_rowid: number
}
interface SearchSourceRow {
  readonly search_text: string | null
}
interface SearchIdentityRow {
  readonly source_id: string
}
interface SearchRebuildRow {
  readonly after_rowid: number
}
interface MessageRowidRow {
  readonly message_rowid: number
}

class SearchIndexError extends Schema.TaggedError<SearchIndexError>()("SearchIndexError", {
  reason: Schema.Literals(["unsupported_version", "rebuild_required", "corrupt"]),
  message: Schema.String
}) {}

export const initializeSearchIndex = Effect.fn("SqliteSearch.initialize")(function* (
  sql: SqlClient.SqlClient,
  operationalFilename: string,
  options: SearchIndexOptions = {}
) {
  const filename =
    options.searchFilename ??
    (operationalFilename === ":memory:"
      ? ":memory:"
      : join(dirname(operationalFilename), "search.sqlite"))
  yield* sql.unsafe("ATTACH DATABASE ? AS search", [filename])
  const version = yield* searchVersion(sql)
  const upgradable = version !== 0 && version < searchSchemaSection.version
  if (upgradable) yield* upgradeSearchSchema(sql, version)
  const current = upgradable ? searchSchemaSection.version : version
  if (current !== 0 && current !== searchSchemaSection.version) {
    return yield* new SearchIndexError({
      reason: "unsupported_version",
      message: `Search schema version ${String(current)} is not supported`
    })
  }
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM search.sqlite_schema WHERE type = 'table' LIMIT 1
  `
  if (current === 0 && existing.length > 0) {
    return yield* new SearchIndexError({
      reason: "rebuild_required",
      message: "Unversioned search database must be rebuilt"
    })
  }
  if (current === 0) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const statement of searchSchemaSection.statements) yield* sql.unsafe(statement)
          yield* sql.unsafe(`PRAGMA search.user_version = ${searchSchemaSection.version}`)
        })
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql))
  }
  const identity = yield* sql<SearchIdentityRow>`
    SELECT source_id FROM transcript_search_source WHERE singleton_id = 1
  `
  const sourceId = identity[0]?.source_id
  if (sourceId === undefined)
    return yield* new SearchIndexError({
      reason: "corrupt",
      message: "Search source identity is missing"
    })
  const cursor = yield* sql<SearchCursorRow>`
    SELECT applied_sequence, source_id FROM search.transcript_cursor WHERE singleton_id = 1
  `
  if (cursor[0] !== undefined && cursor[0].source_id !== sourceId) {
    return yield* new SearchIndexError({
      reason: "rebuild_required",
      message: "Search database belongs to a different operational source; rebuild required"
    })
  }
  // A new index starts empty at the head of the change log. The engine fills it
  // from main.session_messages in the background (transcriptSearchStep), a
  // chunk per transaction from a saved position, so startup does not wait for
  // it and a stopped fill resumes.
  if (cursor.length === 0) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const clock = yield* sql<SearchClockRow>`
        SELECT head_sequence FROM transcript_search_clock WHERE singleton_id = 1
      `
          if (clock[0] === undefined)
            return yield* new SearchIndexError({
              reason: "corrupt",
              message: "Search change clock is missing"
            })
          yield* sql.unsafe(
            "INSERT INTO search.session_messages_fts(session_messages_fts) VALUES ('delete-all')"
          )
          yield* sql`
        INSERT INTO search.transcript_cursor(singleton_id, applied_sequence, source_id)
        VALUES (1, ${clock[0].head_sequence}, ${sourceId})
      `
          const newest = yield* sql<{ readonly top: number | null }>`
            SELECT max(message_rowid) AS top FROM main.session_messages
          `
          if (newest[0]?.top != null)
            yield* sql`
        INSERT OR REPLACE INTO search.transcript_rebuild(singleton_id, after_rowid) VALUES (1, 0)
      `
        })
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql))
  }
})

const searchVersion = Effect.fn("SqliteSearch.version")(function* (sql: SqlClient.SqlClient) {
  const versions = yield* sql.unsafe<{ readonly user_version: number }>(
    "PRAGMA search.user_version"
  )
  const version = versions[0]?.user_version
  if (version === undefined)
    return yield* new SearchIndexError({
      reason: "corrupt",
      message: "Search schema version is unreadable"
    })
  return version
})

const upgradeSearchSchema = Effect.fn("SqliteSearch.upgrade")(function* (
  sql: SqlClient.SqlClient,
  version: number
) {
  for (let from = version; from < searchSchemaSection.version; from += 1) {
    const steps = searchSchemaUpgrades[from]
    if (steps === undefined)
      return yield* new SearchIndexError({
        reason: "unsupported_version",
        message: `Search schema version ${String(from)} cannot be upgraded`
      })
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const statement of steps) yield* sql.unsafe(statement)
          yield* sql.unsafe(`PRAGMA search.user_version = ${String(from + 1)}`)
        })
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql))
  }
})

/** Brings the index up to the head of the change log, a batch per
 * transaction. It never fills the index: true while a refill (the background
 * step below) has not reached every message, so a search sees only part. */
export const catchUpTranscriptSearch = Effect.fn("SqliteSearch.catchUp")(function* (
  sql: SqlClient.SqlClient
) {
  for (;;) {
    if (!(yield* applyTranscriptChangeBatch(sql))) break
  }
  const rebuild = yield* sql<SearchRebuildRow>`
    SELECT after_rowid FROM search.transcript_rebuild WHERE singleton_id = 1
  `
  return rebuild.length > 0
})

/** One step of background index upkeep, in one transaction: a batch of
 * changes, or else the next chunk of a refill. False when there is nothing to do. */
const transcriptSearchStep = Effect.fn("SqliteSearch.step")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly rebuildBatchSize?: number } = {}
) {
  if (yield* applyTranscriptChangeBatch(sql)) return true
  return yield* rebuildTranscriptSearchBatch(sql, options.rebuildBatchSize ?? REBUILD_BATCH_SIZE)
})

/** The engine's background fill: one step per write-queue item, giving way to
 * other writes and to active runs between steps. Searches meanwhile read the
 * part already indexed. */
export const fillTranscriptSearch = (writer: Writer): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      // The span names the write: the write queue reports a slow write by the
      // span it was submitted in, and this one was reported as "untraced".
      const stepped = yield* writer
        .run(transcriptSearchStep(writer.sql))
        .pipe(Effect.withSpan("SqliteSearch.fill"))
      if (!stepped) return
      yield* pauseBetweenBatches(yield* runIsActive(writer.reader))
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Search index fill stopped; it resumes on the next start", cause)
    )
  )

/** Keeps the index current for as long as the engine runs. A changed message
 * leaves a row in `transcript_search_changes`, and the index applied those
 * rows only at the next search or the next launch: after a long session the
 * launch applied the whole backlog in large writes. This applies them within
 * seconds, in small writes, so no backlog builds up. The look for pending
 * rows is one read of a table that is empty when there is nothing to do. */
export const keepTranscriptSearchCurrent = (writer: Writer): Effect.Effect<void> =>
  fillTranscriptSearch(writer).pipe(
    Effect.andThen(
      timerSleep(KEEP_CURRENT_EVERY).pipe(
        Effect.andThen(
          writer.reader<{ readonly pending: number }>`
            SELECT 1 AS pending FROM transcript_search_changes LIMIT 1`
        ),
        Effect.flatMap((rows) => (rows.length > 0 ? fillTranscriptSearch(writer) : Effect.void)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not look for pending search index changes", cause)
        ),
        Effect.forever
      )
    )
  )

/** Runs every step until the index is complete: for tools that build an index
 * offline, not for the running engine. */
export const refillTranscriptSearch = Effect.fn("SqliteSearch.refill")(function* (
  sql: SqlClient.SqlClient,
  options: { readonly rebuildBatchSize?: number } = {}
) {
  for (;;) {
    if (!(yield* transcriptSearchStep(sql, options))) return
  }
})

const applyTranscriptChangeBatch = Effect.fn("SqliteSearch.applyChanges")(function* (
  sql: SqlClient.SqlClient
) {
  const advanced = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const clock = yield* sql<SearchClockRow>`
        SELECT head_sequence FROM transcript_search_clock WHERE singleton_id = 1
      `
        const cursor = yield* sql<SearchCursorRow>`
        SELECT applied_sequence, source_id FROM search.transcript_cursor WHERE singleton_id = 1
      `
        const identity = yield* sql<SearchIdentityRow>`
        SELECT source_id FROM transcript_search_source WHERE singleton_id = 1
      `
        const head = clock[0]?.head_sequence
        const applied = cursor[0]?.applied_sequence
        if (
          head === undefined ||
          applied === undefined ||
          applied > head ||
          cursor[0]?.source_id !== identity[0]?.source_id
        ) {
          return yield* new SearchIndexError({
            reason: "corrupt",
            message: "Transcript search cursor is corrupt"
          })
        }
        if (applied === head) {
          // A new or reset index starts at the head, and the rows before it
          // would stay for good: the look for pending rows would never rest.
          yield* sql`DELETE FROM transcript_search_changes WHERE sequence <= ${applied}`
          return false
        }
        const changes = yield* sql<SearchChangeRow>`
        SELECT sequence, message_rowid FROM transcript_search_changes
        WHERE sequence > ${applied} AND sequence <= ${head}
        ORDER BY sequence LIMIT ${CHANGE_BATCH_SIZE}
      `
        if (
          changes.length === 0 ||
          changes.some(
            (change, index) => change.sequence !== (changes[index - 1]?.sequence ?? applied) + 1
          )
        ) {
          return yield* new SearchIndexError({
            reason: "corrupt",
            message: "Transcript search change log has a gap"
          })
        }
        // While a rebuild runs, a message past its position is left to the
        // rebuild, which reads the message's text when it gets there.
        const rebuild = yield* sql<SearchRebuildRow>`
        SELECT after_rowid FROM search.transcript_rebuild WHERE singleton_id = 1
      `
        const indexedThrough = rebuild[0]?.after_rowid ?? Number.POSITIVE_INFINITY
        for (const change of changes) {
          if (change.message_rowid > indexedThrough) continue
          const source = yield* sql<SearchSourceRow>`
          SELECT search_text FROM session_messages WHERE message_rowid = ${change.message_rowid}
        `
          yield* sql`DELETE FROM search.session_messages_fts WHERE rowid = ${change.message_rowid}`
          const text = source[0]?.search_text
          if (text !== undefined && text !== null) {
            yield* sql`INSERT INTO search.session_messages_fts(rowid, search_text)
            VALUES (${change.message_rowid}, ${text})`
          }
        }
        const last = changes[changes.length - 1]
        if (last === undefined)
          return yield* new SearchIndexError({
            reason: "corrupt",
            message: "Transcript search change log is empty"
          })
        yield* sql`UPDATE search.transcript_cursor SET applied_sequence = ${last.sequence}
        WHERE singleton_id = 1`
        return last.sequence
      })
    )
    .pipe(Effect.provideService(SqlClient.SqlClient, sql))
  if (advanced === false) return false
  yield* sql`DELETE FROM transcript_search_changes WHERE sequence <= ${advanced}`
  return true
})

/** Copies the next chunk of messages into the index; false once no rebuild is
 * in progress. */
const rebuildTranscriptSearchBatch = Effect.fn("SqliteSearch.rebuildBatch")(function* (
  sql: SqlClient.SqlClient,
  batchSize: number
) {
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const rebuild = yield* sql<SearchRebuildRow>`
          SELECT after_rowid FROM search.transcript_rebuild WHERE singleton_id = 1
        `
        const after = rebuild[0]?.after_rowid
        if (after === undefined) return false
        const last = yield* sql<MessageRowidRow>`
          SELECT message_rowid FROM main.session_messages
          WHERE message_rowid > ${after}
          ORDER BY message_rowid
          LIMIT 1 OFFSET ${batchSize - 1}
        `
        const through = last[0]?.message_rowid
        const upTo = through === undefined ? sql`` : sql`AND message_rowid <= ${through}`
        yield* sql`
          INSERT INTO search.session_messages_fts(rowid, search_text)
          SELECT message_rowid, search_text FROM main.session_messages
          WHERE message_rowid > ${after} ${upTo} AND search_text IS NOT NULL
          ORDER BY message_rowid
        `
        if (through === undefined) {
          yield* sql`DELETE FROM search.transcript_rebuild WHERE singleton_id = 1`
          return false
        }
        yield* sql`
          UPDATE search.transcript_rebuild SET after_rowid = ${through} WHERE singleton_id = 1
        `
        return true
      })
    )
    .pipe(Effect.provideService(SqlClient.SqlClient, sql))
})
