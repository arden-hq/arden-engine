import { stripCitationMarkers } from "@arden-hq/protocol/chat"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import {
  TranscriptDataCorruptionError,
  TranscriptQueryError,
  TranscriptSearchError,
  type ConversationFind,
  type ConversationFindHit,
  type ChatSearchChat
} from "../transcript/queries.js"
import { findTextRanges } from "@arden-hq/protocol/views"
import {
  TranscriptSearchInputSchema,
  TranscriptSearchPageSchema,
  type TranscriptSearchInput
} from "../transcript/model.js"
import { catchUpTranscriptSearch } from "./search.js"
import {
  findSnippet,
  markFtsQueryWords,
  markWords,
  snippetWithFileNames,
  visibleText,
  wordStartRanges
} from "./find-snippet.js"
import {
  rankedRows,
  isInternalSearchMessage,
  indexIsCurrent,
  ftsQueryForFindText,
  bracketed,
  ftsQueryForWords,
  type SearchRow,
  isMalformedFtsQuery,
  searchError
} from "./transcript-search-text.js"
import type { TranscriptQueries } from "../transcript/queries.js"

interface SearchScopeRow {
  readonly space_id: string | null
}

interface SearchTargetRow {
  readonly session_id: string
}

const searchIn = Effect.fn("SqliteTranscriptQueries.search")(function* (
  searchSql: SqlClient.SqlClient,
  input: TranscriptSearchInput
) {
  const query = yield* Schema.decodeUnknownEffect(TranscriptSearchInputSchema)(input).pipe(
    Effect.mapError((cause) => searchError("invalid", "Invalid transcript search query", cause))
  )

  const scopeRows = yield* searchSql<SearchScopeRow>`
    SELECT space_id
    FROM sessions
    WHERE session_id = ${query.requestingSessionId}
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      searchError("storage", "Could not resolve transcript search scope", cause)
    )
  )
  const scope = scopeRows[0]
  if (scope === undefined) {
    return yield* searchError("not_found", "Requesting session was not found")
  }

  let targetSessionId: string | undefined
  if (query.sessionRef !== undefined) {
    const targetRows = yield* searchSql<SearchTargetRow>`
      SELECT session_id
      FROM sessions
      WHERE public_ref = ${query.sessionRef}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        searchError("storage", "Could not resolve transcript search target", cause)
      )
    )
    targetSessionId = targetRows[0]?.session_id
    if (targetSessionId === undefined) {
      return yield* searchError("not_found", "Transcript search target was not found")
    }
  }

  const indexing = yield* catchUpTranscriptSearch(searchSql).pipe(
    Effect.mapError((cause) => searchError("storage", "Transcript search is not ready", cause))
  )
  const clauses = [indexIsCurrent(searchSql)]
  if (targetSessionId !== undefined) clauses.push(searchSql`m.session_id = ${targetSessionId}`)
  else {
    clauses.push(searchSql`s.archived_at IS NULL`)
    if (scope.space_id !== null && query.allSpaces !== true) {
      clauses.push(searchSql`s.space_id = ${scope.space_id}`)
    }
    clauses.push(searchSql`NOT (s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
      AND COALESCE(json_type(s.metadata, '$.fork_origin'),
        json_type(s.metadata, '$.fork_of')) IS NOT NULL)`)
  }
  if (query.since !== undefined) {
    clauses.push(searchSql`julianday(m.created_at) >= julianday(${query.since})`)
  }

  const ranked = (match: string) =>
    rankedRows(searchSql, {
      grouped: targetSessionId === undefined,
      clauses: [searchSql`session_messages_fts MATCH ${match}`, ...clauses],
      limit: query.limit,
      offset: query.offset
    })
  const found = yield* ranked(query.query).pipe(
    Effect.map((rows) => ({ rows, match: query.query })),
    Effect.catchIf(
      (error) => error.reason === "invalid",
      (error) => {
        const words = ftsQueryForWords(query.query)
        return words === undefined
          ? Effect.fail(error)
          : ranked(words).pipe(Effect.map((rows) => ({ rows, match: words })))
      }
    )
  )
  return yield* searchPage({ ...found, indexing }, query.limit, query.requestingSessionId)
})

const searchPage = (
  {
    rows,
    match,
    indexing
  }: {
    readonly rows: ReadonlyArray<SearchRow>
    readonly match: string
    readonly indexing: boolean
  },
  limit: number,
  sessionId: string
) =>
  Schema.decodeUnknownEffect(TranscriptSearchPageSchema)({
    hits: rows.slice(0, limit).map((row) => ({
      sessionId: row.session_id,
      sessionRef: row.public_ref,
      sessionName: row.session_name,
      ...(row.space_name === null ? {} : { spaceName: row.space_name }),
      messageId: row.message_id,
      sequence: row.seq,
      role: row.role,
      createdAt: row.created_at,
      snippet: bracketed(
        findSnippet(markFtsQueryWords(stripCitationMarkers(row.search_text ?? ""), match))
      ),
      matchCount: row.match_count
    })),
    hasMore: rows.length > limit,
    indexing
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TranscriptDataCorruptionError({
          sessionId,
          message: "Transcript search result is corrupt",
          cause
        })
    )
  )

interface ChatSearchRow {
  readonly message_rowid: number
  readonly session_id: string
  readonly session_name: string | null
  readonly last_activity: string
  readonly message_id: string
  readonly created_at: string
  readonly search_text: string | null
  readonly message_json: string
}

const CHAT_SEARCH_MIN_CHARS = 2
const CHAT_SEARCH_NAME_MATCHES_FIRST = 5
const CHAT_SEARCH_MATCHES_PER_QUERY = 100

const ownerChatSql = (searchSql: SqlClient.SqlClient, alias: string) => searchSql`
    ${searchSql(alias)}.archived_at IS NULL
    AND ${searchSql(alias)}.session_type = 'chat'
    AND ${searchSql(alias)}.parent_session_id IS NULL
    AND ${searchSql(alias)}.parent_message_id IS NULL
  `

export const ownerNamedChats = (
  searchSql: SqlClient.SqlClient
): Statement.Statement<NamedChatRow> => searchSql<NamedChatRow>`
    SELECT s.session_id, s.name, s.last_activity
    FROM sessions AS s INDEXED BY idx_sessions_owner_chats
    WHERE ${ownerChatSql(searchSql, "s")} AND s.name IS NOT NULL
    ORDER BY s.last_activity DESC, s.session_id DESC
  `

const searchChatsIn = Effect.fn("SqliteTranscriptQueries.searchChats")(function* (
  searchSql: SqlClient.SqlClient,
  conversation: Statement.Fragment,
  input: { readonly query: string; readonly limit: number },
  noteIndexing: Effect.Effect<void>
) {
  const ownerChat = (alias: string) => ownerChatSql(searchSql, alias)
  const match =
    input.query.trim().length < CHAT_SEARCH_MIN_CHARS ? undefined : ftsQueryForFindText(input.query)
  if (match === undefined) return { chats: [], hasMore: false }
  const namedRows = yield* ownerNamedChats(searchSql).pipe(
    Effect.mapError((cause) => searchError("storage", "Could not search chat names", cause))
  )
  const namedAll = namedRows.flatMap((row) => {
    const ranges = wordStartRanges(row.name, input.query)
    return ranges === undefined ? [] : [{ row, ranges }]
  })
  const namedMatches = namedAll.length
  const named = namedAll.slice(0, CHAT_SEARCH_NAME_MATCHES_FIRST)
  const indexing = yield* catchUpTranscriptSearch(searchSql).pipe(
    Effect.mapError((cause) => searchError("storage", "Transcript search is not ready", cause))
  )
  if (indexing) yield* noteIndexing
  const newest = new Map<string, ChatSearchRow & { readonly marked: string }>()
  const namedIds = new Set(named.map(({ row }) => row.session_id))
  const messageChats = () => [...newest.keys()].filter((id) => !namedIds.has(id)).length
  let beforeRowId: number | undefined
  while (messageChats() <= input.limit) {
    const cursor =
      beforeRowId === undefined
        ? searchSql``
        : searchSql`AND session_messages_fts.rowid < ${beforeRowId}`
    const seen = [...newest.keys()]
    const unseen =
      seen.length === 0 ? searchSql`` : searchSql`AND m.session_id NOT IN ${searchSql.in(seen)}`
    const batch = yield* searchSql<ChatSearchRow>`
    SELECT m.message_rowid,
           s.session_id,
           s.name AS session_name,
           s.last_activity,
           m.message_id,
           m.created_at,
           m.search_text,
           m.message_json
    FROM search.session_messages_fts
    JOIN session_messages AS m ON m.message_rowid = session_messages_fts.rowid
    JOIN sessions AS s ON s.session_id = m.session_id
    WHERE session_messages_fts MATCH ${match}
      AND +session_messages_fts.rowid IN (
        SELECT owned.message_rowid
        FROM sessions AS chat
        JOIN session_messages AS owned ON owned.session_id = chat.session_id
        WHERE ${ownerChat("chat")}
      )
      AND ${ownerChat("s")}
      -- Only rows the chat draws, so opening a hit lands on something.
      AND ${conversation}
      AND ${indexIsCurrent(searchSql)}
      ${unseen}
      ${cursor}
    ORDER BY session_messages_fts.rowid DESC
    LIMIT ${CHAT_SEARCH_MATCHES_PER_QUERY}
    `.pipe(
      Effect.mapError((cause) =>
        isMalformedFtsQuery(cause)
          ? searchError("invalid", "Invalid FTS5 transcript query", cause)
          : searchError("storage", "Could not search transcripts", cause)
      )
    )
    for (const row of batch) {
      if (newest.has(row.session_id)) continue
      const marked = markWords(
        visibleText(stripCitationMarkers(row.search_text ?? "")),
        input.query
      )
      if (marked === undefined) continue
      if (yield* isInternalSearchMessage(searchSql, row)) continue
      newest.set(row.session_id, { ...row, marked })
      if (messageChats() > input.limit) break
    }
    if (batch.length < CHAT_SEARCH_MATCHES_PER_QUERY) break
    beforeRowId = batch.at(-1)?.message_rowid
  }
  const previews = new Map<string, ChatSearchRow>()
  for (const { row: chat } of named) {
    if (newest.has(chat.session_id)) continue
    const recent = yield* searchSql<ChatSearchRow>`
      SELECT m.message_rowid, s.session_id, s.name AS session_name, s.last_activity,
             m.message_id, m.created_at, m.search_text, m.message_json
      FROM session_messages AS m
      JOIN sessions AS s ON s.session_id = m.session_id
      WHERE m.session_id = ${chat.session_id} AND m.search_text IS NOT NULL AND ${conversation}
      ORDER BY m.seq DESC
      LIMIT 5
    `.pipe(
      Effect.mapError((cause) =>
        searchError("storage", "Could not read a chat's newest message", cause)
      )
    )
    for (const row of recent) {
      if (yield* isInternalSearchMessage(searchSql, row)) continue
      previews.set(row.session_id, row)
      break
    }
  }
  const lineOf = (row: ChatSearchRow, marked: string) => {
    const line = findSnippet(snippetWithFileNames(marked, row.search_text ?? ""))
    return {
      messageId: row.message_id,
      createdAt: row.created_at,
      snippet: line.text,
      ranges: line.ranges
    }
  }
  const entry = (
    chat: {
      readonly sessionId: string
      readonly sessionName: string | null
      readonly lastActivity: string
    },
    nameRanges: ReadonlyArray<readonly [number, number]>
  ): ChatSearchChat => {
    const hit = newest.get(chat.sessionId)
    if (hit !== undefined)
      return { ...chat, nameRanges, match: "message", hit: lineOf(hit, hit.marked) }
    const preview = previews.get(chat.sessionId)
    return {
      ...chat,
      nameRanges,
      match: "name",
      preview:
        preview === undefined
          ? undefined
          : lineOf(preview, visibleText(stripCitationMarkers(preview.search_text ?? "")))
    }
  }
  const byMessage = [...newest.values()].filter((row) => !namedIds.has(row.session_id))
  return {
    chats: [
      ...named.map(({ row, ranges }) =>
        entry(
          { sessionId: row.session_id, sessionName: row.name, lastActivity: row.last_activity },
          ranges
        )
      ),
      ...byMessage.slice(0, input.limit).map((row) =>
        entry(
          {
            sessionId: row.session_id,
            sessionName: row.session_name,
            lastActivity: row.last_activity
          },
          []
        )
      )
    ],
    hasMore: byMessage.length > input.limit || named.length < namedMatches
  }
})

interface NamedChatRow {
  readonly session_id: string
  readonly name: string
  readonly last_activity: string
}

const makeTranscriptSearch = (searchSql: SqlClient.SqlClient) => (input: TranscriptSearchInput) =>
  searchIn(searchSql, input).pipe(
    Effect.mapError((cause) =>
      cause instanceof TranscriptSearchError || cause instanceof TranscriptDataCorruptionError
        ? cause
        : searchError("storage", "Could not search transcripts", cause)
    )
  )

const makeChatSearch = (searchSql: SqlClient.SqlClient, conversation: Statement.Fragment) => {
  let noted = false
  const noteIndexing = Effect.suspend(() => {
    if (noted) return Effect.void
    noted = true
    return Effect.logInfo("Chat search ran while the search index is still being filled")
  })
  return (input: { readonly query: string; readonly limit: number }) =>
    searchChatsIn(searchSql, conversation, input, noteIndexing)
}

interface FindRow {
  readonly session_id: string
  readonly message_id: string
  readonly message_json: string | null
  readonly parent_session_ref: string | null
  readonly seq: number
  readonly search_text: string | null
}

const FIND_MAX_ROWS = 5_000
const FIND_MAX_HITS = 1_000
const ASCII_ONLY = /^[\x20-\x7e]*$/u

const makeConversationFind = (sql: SqlClient.SqlClient, conversation: Statement.Fragment) =>
  Effect.fn("SqliteTranscriptQueries.findInConversation")(function* (
    sessionId: string,
    query: string
  ): Effect.fn.Return<ConversationFind, TranscriptQueryError | TranscriptDataCorruptionError> {
    const needle = query.trim()
    if (needle.length === 0) return { hits: [], truncated: false }
    const narrow = ASCII_ONLY.test(needle)
      ? sql`instr(lower(m.search_text), ${needle.toLowerCase()}) > 0 AND`
      : sql``
    const rows = yield* sql<FindRow>`
      SELECT m.session_id, m.message_id, m.seq,
        (SELECT public_ref FROM sessions WHERE session_id = (
          SELECT parent_session_id FROM sessions WHERE session_id = ${sessionId}
        )) AS parent_session_ref,
        CASE WHEN ${narrow} (${conversation}) THEN m.message_json END AS message_json,
        CASE WHEN ${narrow} (${conversation}) THEN m.search_text END AS search_text
      FROM session_messages AS m
      WHERE m.message_rowid IN (
        SELECT message_rowid FROM session_messages
        WHERE session_id = ${sessionId} AND search_text IS NOT NULL
        ORDER BY seq DESC
        LIMIT ${FIND_MAX_ROWS + 1}
      )
      ORDER BY m.seq DESC
    `.pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptQueryError({
            operation: "page",
            sessionId,
            message: "Could not find in the conversation",
            cause
          })
      )
    )
    const hits: ConversationFindHit[] = []
    for (const row of rows.slice(0, FIND_MAX_ROWS)) {
      if (row.search_text === null || row.message_json === null) continue
      const count = findTextRanges(visibleText(row.search_text), needle).length
      if (count === 0) continue
      if (yield* isInternalSearchMessage(sql, { ...row, message_json: row.message_json })) continue
      if (hits.length === FIND_MAX_HITS) return { hits: hits.reverse(), truncated: true }
      hits.push({ messageId: row.message_id, sequence: row.seq, count })
    }
    return { hits: hits.reverse(), truncated: rows.length > FIND_MAX_ROWS }
  })

export const makeTranscriptSearches = (
  reader: SqlClient.SqlClient,
  writer: SqlClient.SqlClient,
  conversation: (sql: SqlClient.SqlClient) => Statement.Fragment
): Pick<TranscriptQueries["Service"], "search" | "findInConversation" | "searchChats"> => ({
  search: makeTranscriptSearch(writer),
  findInConversation: makeConversationFind(reader, conversation(reader)),
  searchChats: makeChatSearch(writer, conversation(writer))
})
