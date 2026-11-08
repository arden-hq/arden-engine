import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { DateTime, Effect, Schema, SchemaTransformation } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import {
  TranscriptDataCorruptionError,
  TranscriptQueries,
  type TranscriptSearchFailure
} from "../persistence/transcript/queries.js"
import { SummaryStore, type ChatSummary } from "../persistence/summaries/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { chatSummaryText } from "./chat-summary.js"
import { toolFailure } from "./tool-failure.js"
import { BrowseScopeSchema, spaceLabel, permittedBrowseScope } from "./session-browse-scope.js"

const QueryInputSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500)
).annotate({
  description: "FTS5 query. Bare words are AND-ed; quote exact phrases. Maximum 500 characters."
})
const QuerySchema = QueryInputSchema.pipe(
  Schema.decodeTo(
    Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    SchemaTransformation.trim()
  )
)

const LimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
  .annotate({
    description:
      "Maximum results (chats; messages with session_ref) to return, from 1 to 100. Defaults to 20."
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed(20)))

const OffsetSchema = Schema.Natural.annotate({
  description: "Number of ranked results to skip. Defaults to 0."
}).pipe(Schema.withDecodingDefault(Effect.succeed(0)))

const WithinDaysSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 3_650 })
).annotate({
  description: "Only search messages from the last N days. Omit for all time."
})

const ParametersSchema = Schema.Struct({
  query: QuerySchema,
  limit: LimitSchema,
  offset: OffsetSchema,
  session_ref: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description: "Search only this exact session_ref, on any Space, archived or not."
    })
  ),
  within_days: Schema.optionalKey(WithinDaysSchema),
  scope: Schema.optionalKey(BrowseScopeSchema)
})

interface SearchHit {
  readonly session_ref: string
  readonly session_name: string | null
  readonly space: string | undefined
  readonly message_id: string
  readonly sequence: number
  readonly role: string
  readonly created_at: string
  readonly snippet: string
  readonly match_count: number
}

interface SourceRef {
  readonly provider: "arden"
  readonly kind: "message"
  readonly ref: string
  readonly title: string
  readonly within: string
  readonly use: "found"
}

const failurePreview = (
  error: Exclude<TranscriptSearchFailure, TranscriptDataCorruptionError>
): string => {
  switch (error.reason) {
    case "not_found":
      return "Session not found"
    case "invalid":
      return "Invalid search query"
    case "storage":
      return "Search unavailable"
  }
}

const searchFailure = (error: TranscriptSearchFailure): ToolExecutionError =>
  error instanceof TranscriptDataCorruptionError
    ? toolFailure(
        { reason: error.reason, message: "Transcript search data is corrupt" },
        "Search unavailable"
      )
    : toolFailure(error, failurePreview(error))

const formatHit = (hit: SearchHit, scoped: boolean): string => {
  const space = hit.space === undefined ? "" : ` · ${hit.space}`
  const matches = scoped ? "" : ` · ${hit.match_count} matching`
  return `- ${hit.session_ref} #${hit.sequence} · ${hit.session_name ?? "(untitled)"}${space}${matches} · ${hit.created_at} · [${hit.role}] ${hit.snippet}`
}

const renderSearchResults = (
  hits: ReadonlyArray<SearchHit>,
  summaries: ReadonlyArray<string>,
  query: string,
  hasMore: boolean,
  nextOffset: number,
  scoped: boolean
): string => {
  if (hits.length === 0) return `No readable matches for ${JSON.stringify(query)}.`
  const chats =
    summaries.length === 0 ? "" : `\n\nWhat these chats covered:\n${summaries.join("\n")}`
  const listing = hits.map((hit) => formatHit(hit, scoped)).join("\n") + chats
  const evidence =
    "Historical transcript evidence — verify mutable current state in its owning record."
  if (!hasMore) return `${evidence}\n${listing}`
  return `${evidence}\n${listing}\n\nMore results: session_search_transcripts(offset=${nextOffset})`
}

const sourceRef = (hit: SearchHit): SourceRef => ({
  provider: "arden",
  kind: "message",
  ref: `${hit.session_ref}:${hit.message_id}`,
  title: `${hit.session_ref} message ${hit.sequence}`,
  within: hit.session_ref,
  use: "found"
})

const makeSessionSearchTool = ({
  transcript,
  summaries,
  queries
}: {
  readonly transcript: TranscriptQueries["Service"]
  readonly summaries: SummaryStore["Service"]
  readonly queries: SessionQueries["Service"]
}): ServerTool =>
  defineServerTool({
    name: "session_search_transcripts",
    description: [
      "Full-text search across unarchived chat transcripts, one result per chat: its best-matching message and how many of its messages match, chats ranked by relevance. With session_ref it lists that chat's matching messages instead.",
      "Old and manually created chats are included.",
      "Transcript hits are dated historical evidence, not current mutable state.",
      "Inside a Space, hits stay within that Space unless scope is all_spaces, which only the user's own chat and a Space review may use; each hit then names its Space.",
      "Optionally restrict by session_ref or recent days. Each hit includes session_ref and sequence.",
      "Use session_read with around_seq=<sequence> to inspect a hit. Read-only."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Search Transcripts",
      kind: "tool",
      action: "read",
      approval_preview: "Search chat transcript text.",
      source: "_sessions",
      changes_state: false,
      concurrency_group: null,
      background: true,
      destructive: null
    },
    execute: async (input, ctx) => {
      const allSpaces = permittedBrowseScope(input.scope, ctx.run) === "all_spaces"
      const spansSpaces =
        allSpaces ||
        (input.session_ref === undefined &&
          (await Effect.runPromise(
            queries.loadHistoryHeader(ctx.run.sessionId).pipe(
              Effect.map((header) => header?.spaceId === null),
              Effect.orElseSucceed(() => false)
            ),
            { signal: ctx.signal }
          )))
      const since =
        input.within_days === undefined
          ? undefined
          : DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { days: input.within_days }))
      const page = await Effect.runPromise(
        transcript
          .search({
            requestingSessionId: ctx.run.sessionId,
            ...(allSpaces ? { allSpaces } : {}),
            query: input.query,
            limit: input.limit,
            offset: input.offset,
            ...(input.session_ref === undefined ? {} : { sessionRef: input.session_ref }),
            ...(since === undefined ? {} : { since })
          })
          .pipe(Effect.mapError(searchFailure)),
        { signal: ctx.signal }
      )
      const hits: ReadonlyArray<SearchHit> = page.hits.map((hit) => ({
        session_ref: hit.sessionRef,
        session_name: hit.sessionName,
        space: spansSpaces ? spaceLabel(hit.spaceName) : undefined,
        message_id: hit.messageId,
        sequence: hit.sequence,
        role: hit.role,
        created_at: hit.createdAt,
        snippet: hit.snippet,
        match_count: hit.matchCount
      }))
      const found = await Effect.runPromise(
        summaries
          .chats([...new Set(page.hits.map((hit) => hit.sessionId))])
          .pipe(Effect.orElseSucceed((): ReadonlyMap<string, ChatSummary> => new Map())),
        { signal: ctx.signal }
      )
      const content = renderSearchResults(
        hits,
        [...found.values()].map(
          (summary) => `- ${summary.publicRef} · ${chatSummaryText(summary)}`
        ),
        input.query,
        page.hasMore,
        input.offset + input.limit,
        input.session_ref !== undefined
      )
      const source_refs = hits.slice(0, 50).map(sourceRef)
      return {
        result: content,
        preview: `${countOf(hits.length, "hit")}`,
        data: { source_refs },
        host: { source_refs }
      }
    }
  })

export const sessionSearchTools = Effect.gen(function* () {
  return [
    makeSessionSearchTool({
      transcript: yield* TranscriptQueries,
      summaries: yield* SummaryStore,
      queries: yield* SessionQueries
    })
  ]
})
