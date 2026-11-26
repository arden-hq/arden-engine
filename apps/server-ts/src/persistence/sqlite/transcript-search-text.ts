import { ROLE } from "@arden-hq/std/message-vocabulary"
import {
  AgentResultSchema,
  ChatForwardedSourceSchema,
  ChatHandoffSourceSchema,
  ChatUpdateSchema,
  CommunicationEnvelopeSchema,
  InteractionSenderSchema
} from "@arden-hq/protocol/effect/chat"
import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { TranscriptDataCorruptionError } from "../transcript/queries.js"
import { isAgentInstruction, isInternalWorkMessage } from "@arden-hq/protocol/views"
import { StoredMessageEnvelopeSchema } from "../transcript/model.js"
import { type FindSnippet } from "./find-snippet.js"
import { agentResultPresentation } from "./agent-result-presentation.js"
import { decodeJson } from "./json.js"
import type { Row } from "effect/unstable/sql/SqlConnection"
import { TranscriptSearchError } from "../transcript/queries.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
export const indexIsCurrent = (
  searchSql: SqlClient.SqlClient
): Statement.Statement<Row> => searchSql`NOT EXISTS (
    SELECT 1 FROM transcript_search_changes AS pending
    WHERE pending.sequence > (
        SELECT applied_sequence FROM search.transcript_cursor WHERE singleton_id = 1
      )
      AND pending.message_rowid = m.message_rowid
  )`

export const rankedRows = (
  searchSql: SqlClient.SqlClient,
  {
    grouped,
    clauses,
    limit,
    offset
  }: {
    readonly grouped: boolean
    readonly clauses: ReadonlyArray<Statement.Fragment>
    readonly limit: number
    readonly offset: number
  }
): Effect.Effect<readonly SearchRow[], TranscriptSearchError, never> =>
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
           m.search_text,
           page.match_count
    FROM page
    JOIN session_messages AS m ON m.message_rowid = page.rid
    JOIN sessions AS s ON s.session_id = m.session_id
    ORDER BY page.weight ASC, julianday(page.created_at) DESC, page.rid DESC
  `.pipe(
    Effect.mapError((cause) =>
      isMalformedFtsQuery(cause)
        ? searchError("invalid", "Invalid FTS5 transcript query", cause)
        : searchError("storage", "Could not search transcripts", cause)
    )
  )

export const bracketed = ({ text, ranges }: FindSnippet): string => {
  let out = ""
  let at = 0
  for (const [start, end] of ranges) {
    out += `${text.slice(at, start)}[${text.slice(start, end)}]`
    at = end
  }
  return out + text.slice(at)
}

export const ftsQueryForFindText = (text: string): string | undefined =>
  ftsQueryForWords(text, { prefixLast: true })

export const ftsQueryForWords = (
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

export const isInternalSearchMessage = Effect.fn("SqliteTranscriptQueries.isInternalSearchMessage")(
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
    if (envelope.role !== ROLE.interaction) return false
    const sender = Option.getOrUndefined(
      Schema.decodeUnknownOption(InteractionSenderSchema)(envelope)
    )
    const fromChat = Option.getOrUndefined(
      Schema.decodeUnknownOption(ChatHandoffSourceSchema)(envelope.from_chat)
    )
    const forwardedFrom = Option.getOrUndefined(
      Schema.decodeUnknownOption(ChatForwardedSourceSchema)(envelope.forwarded_from)
    )
    const instructionSource = isAgentInstruction(sender, row.parent_session_ref ?? undefined)
      ? (row.parent_session_ref ?? undefined)
      : undefined
    const sourceSessionRef = fromChat?.session_ref ?? instructionSource
    if (
      isInternalWorkMessage({
        role: envelope.role,
        forwarded: forwardedFrom !== undefined,
        carriesWork:
          Option.isSome(
            Schema.decodeUnknownOption(CommunicationEnvelopeSchema)(envelope.communication)
          ) ||
          Option.isSome(Schema.decodeUnknownOption(ChatUpdateSchema)(envelope.update)) ||
          Option.isSome(Schema.decodeUnknownOption(AgentResultSchema)(envelope.agent_result)),
        sender:
          sender === undefined
            ? { kind: "unattributed" }
            : {
                kind: "attributed",
                sender,
                origin:
                  sourceSessionRef === undefined
                    ? { kind: "direct" }
                    : { kind: "from_chat", sessionRef: sourceSessionRef }
              }
      })
    )
      return true
    return isInternalWorkMessage({
      role: envelope.role,
      forwarded: false,
      carriesWork:
        (yield* agentResultPresentation(sql, row.session_id, row.message_id)) !== undefined,
      sender: { kind: "unattributed" }
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

export interface SearchRow {
  readonly session_id: string
  readonly public_ref: string
  readonly session_name: string | null
  readonly space_name: string | null
  readonly message_id: string
  readonly seq: number
  readonly role: string
  readonly created_at: string
  readonly search_text: string | null
  readonly match_count: number
}

export const searchError = (
  reason: "invalid" | "not_found" | "storage",
  message: string,
  cause?: unknown
): TranscriptSearchError =>
  new TranscriptSearchError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const EXACT_MALFORMED_FTS_MESSAGES: ReadonlySet<string> = new Set(["unterminated string"])

export const isMalformedFtsQuery = (error: SqlError): boolean => {
  const cause = error.reason.cause
  if (!Predicate.hasProperty(cause, "message") || !Predicate.isString(cause.message)) {
    return false
  }
  const message = cause.message.toLowerCase()
  return (
    message.startsWith("fts5: syntax error") ||
    message.startsWith("no such column:") ||
    message.startsWith("unknown special query:") ||
    EXACT_MALFORMED_FTS_MESSAGES.has(message)
  )
}
