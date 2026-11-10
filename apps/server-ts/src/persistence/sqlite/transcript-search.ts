import { stripCitationMarkers } from "@arden-hq/protocol/chat"
import {
  AgentResultSchema,
  ChatForwardedSourceSchema,
  ChatHandoffSourceSchema,
  ChatUpdateSchema,
  CommunicationEnvelopeSchema,
  InteractionSchema
} from "@arden-hq/protocol/effect/chat"
import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  TranscriptDataCorruptionError,
  TranscriptQueryError,
  TranscriptSearchError,
  type ConversationFind,
  type ConversationFindHit,
  type ChatSearchChat
} from "../transcript/queries.js"
import { findTextRanges, isAgentInstruction, isInternalWorkMessage } from "@arden-hq/protocol/views"
import {
  StoredMessageEnvelopeSchema,
  TranscriptSearchInputSchema,
  TranscriptSearchPageSchema,
  type TranscriptSearchInput
} from "../transcript/model.js"
import { catchUpTranscriptSearch } from "./search.js"
import {
  findSnippet,
  markWords,
  snippetWithFileNames,
  visibleText,
  wordStartRanges
} from "./find-snippet.js"
import { agentResultPresentation } from "./agent-result-presentation.js"
import { decodeJson } from "./json.js"

interface SearchScopeRow {
  readonly space_id: string | null
}

interface SearchTargetRow {
  readonly session_id: string
}

interface SearchRow {
  readonly session_id: string
  readonly public_ref: string
  readonly session_name: string | null
  readonly space_name: string | null
  readonly message_id: string
  readonly seq: number
  readonly role: string
  readonly created_at: string
  readonly snippet: string | null
  readonly match_count: number
}

const searchError = (
  reason: "invalid" | "not_found" | "storage",
  message: string,
  cause?: unknown
): TranscriptSearchError =>
  new TranscriptSearchError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const isMalformedFtsQuery = (error: SqlError): boolean => {
  const cause = error.reason.cause
  if (!Predicate.hasProperty(cause, "message") || !Predicate.isString(cause.message)) {
    return false
  }
  const message = cause.message.toLowerCase()
  return (
    message.startsWith("fts5: syntax error") ||
    message.startsWith("no such column:") ||
    message.startsWith("unknown special query:") ||
    message === "unterminated string"
  )
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

  yield* catchUpTranscriptSearch(searchSql).pipe(
    Effect.mapError((cause) => searchError("storage", "Transcript search is not ready", cause))
  )
  const clauses = [searchSql`session_messages_fts.search_text = m.search_text`]
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
      match,
      clauses: [searchSql`session_messages_fts MATCH ${match}`, ...clauses],
      limit: query.limit,
      offset: query.offset
    })
  // The query is FTS5 syntax, so OR, NEAR and phrases work. One that does not
  // parse (a bare "foo-bar", stray punctuation) is searched as its quoted words.
  const rows = yield* ranked(query.query).pipe(
    Effect.catchIf(
      (error) => error.reason === "invalid",
      (error) => {
        const words = ftsQueryForWords(query.query)
        return words === undefined ? Effect.fail(error) : ranked(words)
      }
    )
  )
  return yield* searchPage(rows, query.limit, query.requestingSessionId)
})

const rankedRows = (
  searchSql: SqlClient.SqlClient,
  {
    grouped,
    clauses,
    match,
    limit,
    offset
  }: {
    readonly match: string
    readonly grouped: boolean
    readonly clauses: ReadonlyArray<Statement.Fragment>
    readonly limit: number
    readonly offset: number
  }
) =>
  searchSql<SearchRow>`
    WITH matched AS (
      SELECT m.message_rowid AS rid,
             m.session_id,
             session_messages_fts.rank AS score,
             m.created_at
      FROM search.session_messages_fts
      JOIN session_messages AS m ON m.message_rowid = session_messages_fts.rowid
      JOIN sessions AS s ON s.session_id = m.session_id
      WHERE ${searchSql.and(clauses)}
    ),
    ordered AS (
      SELECT rid, session_id, score, created_at,
             COUNT(*) OVER (PARTITION BY session_id) AS match_count,
             ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY score ASC, julianday(created_at) DESC, rid DESC
             ) AS position
      FROM matched
    ),
    page AS (
      SELECT rid, session_id, match_count,
             ${grouped ? searchSql`score * (1 + ln(match_count))` : searchSql`score`} AS weight,
             created_at
      FROM ordered
      WHERE ${grouped ? searchSql`position = 1` : searchSql`1`}
      ORDER BY weight ASC, julianday(created_at) DESC, rid DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    )
    SELECT s.session_id,
           s.public_ref,
           s.name AS session_name,
           (SELECT name FROM spaces WHERE space_id = s.space_id) AS space_name,
           m.message_id,
           m.seq,
           m.role,
           m.created_at,
           substr(snippet(session_messages_fts, 0, '[', ']', '…', 16), 1, 800) AS snippet,
           page.match_count
    FROM page
    JOIN search.session_messages_fts ON session_messages_fts.rowid = page.rid
    JOIN session_messages AS m ON m.message_rowid = page.rid
    JOIN sessions AS s ON s.session_id = m.session_id
    WHERE session_messages_fts MATCH ${match}
    ORDER BY page.weight ASC, julianday(page.created_at) DESC, page.rid DESC
  `.pipe(
    Effect.mapError((cause) =>
      isMalformedFtsQuery(cause)
        ? searchError("invalid", "Invalid FTS5 transcript query", cause)
        : searchError("storage", "Could not search transcripts", cause)
    )
  )

const searchPage = (rows: ReadonlyArray<SearchRow>, limit: number, sessionId: string) =>
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
      snippet: stripCitationMarkers(row.snippet ?? ""),
      matchCount: row.match_count
    })),
    hasMore: rows.length > limit
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

const ftsQueryForFindText = (text: string): string | undefined =>
  ftsQueryForWords(text, { prefixLast: true })

const ftsQueryForWords = (
  text: string,
  options: { readonly prefixLast: boolean } = { prefixLast: false }
): string | undefined => {
  const words = text.split(/\s+/u).filter((word) => word.length > 0)
  if (words.length === 0) return undefined
  return words
    .map((word, index) => {
      const quoted = `"${word.replaceAll('"', '""')}"`
      return options.prefixLast && index === words.length - 1 ? `${quoted}*` : quoted
    })
    .join(" ")
}

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

const isInternalSearchMessage = Effect.fn("SqliteTranscriptQueries.isInternalSearchMessage")(
  function* (
    sql: SqlClient.SqlClient,
    row: {
      readonly session_id: string
      readonly message_id: string
      readonly message_json: string
      readonly parent_session_ref?: string | null
    }
  ) {
    const envelope = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json)
    if (envelope.role !== "user") return false
    const interaction = Option.getOrUndefined(
      Schema.decodeUnknownOption(InteractionSchema)(envelope.interaction)
    )
    const fromChat = Option.getOrUndefined(
      Schema.decodeUnknownOption(ChatHandoffSourceSchema)(envelope.from_chat)
    )
    const forwardedFrom = Option.getOrUndefined(
      Schema.decodeUnknownOption(ChatForwardedSourceSchema)(envelope.forwarded_from)
    )
    const instructionSource = isAgentInstruction(interaction, {
      parentSessionRef: row.parent_session_ref ?? undefined
    })
      ? (row.parent_session_ref ?? undefined)
      : undefined
    const sourceSessionRef = fromChat?.session_ref ?? instructionSource
    if (
      isInternalWorkMessage({
        role: envelope.role,
        interaction,
        communication: Option.getOrUndefined(
          Schema.decodeUnknownOption(CommunicationEnvelopeSchema)(envelope.communication)
        ),
        update: Option.getOrUndefined(
          Schema.decodeUnknownOption(ChatUpdateSchema)(envelope.update)
        ),
        agentResult: Option.getOrUndefined(
          Schema.decodeUnknownOption(AgentResultSchema)(envelope.agent_result)
        ),
        fromChat: sourceSessionRef === undefined ? undefined : { sessionRef: sourceSessionRef },
        forwardedFrom:
          forwardedFrom === undefined ? undefined : { messageId: forwardedFrom.message_id }
      })
    )
      return true
    if (envelope.is_meta !== true) return false
    return isInternalWorkMessage({
      role: envelope.role,
      agentResult: yield* agentResultPresentation(sql, row.session_id, row.message_id)
    })
  },
  (effect, _sql, row) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptDataCorruptionError({
            sessionId: row.session_id,
            message: "Could not classify a search result",
            cause
          })
      )
    )
)

const CHAT_SEARCH_MIN_CHARS = 2
/** Chats whose name matches, listed before the chats whose messages match. */
const CHAT_SEARCH_NAMED = 5
/** Matches read per query. Larger than a page of chats: a match only inside a link
 * target is read and dropped, and words common in links ("https") have many. */
const CHAT_SEARCH_BATCH = 100

const searchChatsIn = Effect.fn("SqliteTranscriptQueries.searchChats")(function* (
  searchSql: SqlClient.SqlClient,
  conversation: Statement.Fragment,
  input: { readonly query: string; readonly limit: number }
) {
  const ownerChat = (alias: string) => searchSql`
    ${searchSql(alias)}.archived_at IS NULL
    AND ${searchSql(alias)}.session_type = 'chat'
    AND ${searchSql(alias)}.parent_session_id IS NULL
    AND ${searchSql(alias)}.parent_message_id IS NULL
  `
  const match =
    input.query.trim().length < CHAT_SEARCH_MIN_CHARS ? undefined : ftsQueryForFindText(input.query)
  if (match === undefined) return { chats: [], hasMore: false }
  // Names are matched here, not in SQL: SQLite folds case for ASCII only.
  // wordStartRanges matches words the way the message index does. The owner has
  // thousands of chats at most.
  const namedRows = yield* searchSql<NamedChatRow>`
    SELECT s.session_id, s.name, s.last_activity
    FROM sessions AS s
    WHERE ${ownerChat("s")} AND s.name IS NOT NULL
    ORDER BY s.last_activity DESC
  `.pipe(Effect.mapError((cause) => searchError("storage", "Could not search chat names", cause)))
  const namedAll = namedRows.flatMap((row) => {
    const ranges = wordStartRanges(row.name, input.query)
    return ranges === undefined ? [] : [{ row, ranges }]
  })
  const namedMatches = namedAll.length
  const named = namedAll.slice(0, CHAT_SEARCH_NAMED)
  yield* catchUpTranscriptSearch(searchSql).pipe(
    Effect.mapError((cause) => searchError("storage", "Transcript search is not ready", cause))
  )
  // Newest first, in the index's own rowid order: SQLite walks the matches
  // from the newest and stops at the limit, so no match is ranked or sorted
  // (bm25 over every match took 0.1–0.6 s on the owner's 190k rows). A match
  // outside the owner's chats (most of them: agent runs) is dropped against
  // the set of their message rowids, read from the (session_id, seq) index,
  // before its message row is read; the unary + keeps that set from driving
  // the index lookup. Each chat keeps its newest match: a chat already found
  // is left out of the next batches, so one long chat cannot use up the walk.
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
      AND session_messages_fts.search_text = m.search_text
      ${unseen}
      ${cursor}
    ORDER BY session_messages_fts.rowid DESC
    LIMIT ${CHAT_SEARCH_BATCH}
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
    if (batch.length < CHAT_SEARCH_BATCH) break
    beforeRowId = batch.at(-1)?.message_rowid
  }
  // A chat that matches only by name shows its newest message, so every row has
  // the same two lines.
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

const makeChatSearch =
  (searchSql: SqlClient.SqlClient, conversation: Statement.Fragment) =>
  (input: { readonly query: string; readonly limit: number }) =>
    searchChatsIn(searchSql, conversation, input)

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
    // SQLite folds case for ASCII only. A plain-ASCII query is narrowed in SQL
    // first; any other is matched below alone, so "ПРИВЕТ" still finds "привет".
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
) => ({
  search: makeTranscriptSearch(writer),
  findInConversation: makeConversationFind(reader, conversation(reader)),
  searchChats: makeChatSearch(writer, conversation(writer))
})
