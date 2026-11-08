import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { dirname, join } from "node:path"
import { searchSchemaSection, searchSchemaUpgrades } from "../schema/search.js"

const CHANGE_BATCH_SIZE = 500

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

class SearchIndexError extends Schema.TaggedError<SearchIndexError>()("SearchIndexError", {
  reason: Schema.Literals(["unsupported_version", "rebuild_required", "corrupt"]),
  message: Schema.String
}) {}

export const initializeSearchIndex = Effect.fn("SqliteSearch.initialize")(function* (
  sql: SqlClient.SqlClient,
  operationalFilename: string,
  options?: { readonly searchFilename: string }
) {
  const filename =
    options?.searchFilename ??
    (operationalFilename === ":memory:"
      ? ":memory:"
      : join(dirname(operationalFilename), "search.sqlite"))
  yield* sql.unsafe("ATTACH DATABASE ? AS search", [filename])
  const versions = yield* sql.unsafe<{ readonly user_version: number }>(
    "PRAGMA search.user_version"
  )
  const version = versions[0]?.user_version
  const upgradable = version !== undefined && version !== 0 && version < searchSchemaSection.version
  if (upgradable) yield* upgradeSearchSchema(sql, version)
  const current = upgradable ? searchSchemaSection.version : version
  if (current !== 0 && current !== searchSchemaSection.version) {
    return yield* new SearchIndexError({
      reason: "unsupported_version",
      message: `Search schema version ${String(version)} is not supported`
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
          yield* sql.unsafe("DELETE FROM search.session_messages_fts")
          yield* sql.unsafe(`INSERT INTO search.session_messages_fts(rowid, search_text)
        SELECT message_rowid, search_text FROM main.session_messages`)
          yield* sql`
        INSERT INTO search.transcript_cursor(singleton_id, applied_sequence, source_id)
        VALUES (1, ${clock[0].head_sequence}, ${sourceId})
      `
        })
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql))
  }
  yield* catchUpTranscriptSearch(sql)
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

export const catchUpTranscriptSearch = Effect.fn("SqliteSearch.catchUp")(function* (
  sql: SqlClient.SqlClient
) {
  while (true) {
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
          if (applied === head) return false
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
          for (const change of changes) {
            const source = yield* sql<SearchSourceRow>`
          SELECT search_text FROM session_messages WHERE message_rowid = ${change.message_rowid}
        `
            yield* sql`DELETE FROM search.session_messages_fts WHERE rowid = ${change.message_rowid}`
            if (source[0] !== undefined) {
              yield* sql`INSERT INTO search.session_messages_fts(rowid, search_text)
            VALUES (${change.message_rowid}, ${source[0].search_text})`
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
    if (advanced === false) return
    yield* sql`DELETE FROM transcript_search_changes WHERE sequence <= ${advanced}`
  }
})
