import { DateTime, Effect, Schema } from "effect"
import {
  SummaryStore,
  SummaryStoreError,
  type ChatSummary,
  type SpaceOverviewRevision
} from "../summaries/store.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import { spaceOverviewInput } from "./space-overview-input.js"
import { overviewSourceFreshness } from "../summaries/freshness.js"

interface ChatSummaryRow {
  readonly session_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly space_id: string | null
  readonly last_activity: string
  readonly title: string
  readonly summary: string
  readonly topics_json: string
  readonly through_sequence: number
  readonly run_id: string | null
  readonly updated_at: string
}

const Strings = Schema.Array(Schema.String)
const SourceRefs = Schema.Array(
  Schema.Struct({
    sessionId: Schema.String,
    throughSequence: Schema.Int,
    runId: Schema.NullOr(Schema.String)
  })
)

const failure =
  (operation: SummaryStoreError["operation"], message: string) =>
  (cause: unknown): SummaryStoreError =>
    new SummaryStoreError({ operation, reason: "storage", message, cause })

export const makeSummaryStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">) => {
  const sql = writer.sql
  const chatSummary = Effect.fn("SqliteSummaryStore.chatRow")(function* (row: ChatSummaryRow) {
    return {
      sessionId: row.session_id,
      publicRef: row.public_ref,
      chatName: row.name,
      spaceId: row.space_id,
      lastActivity: row.last_activity,
      title: row.title,
      summary: row.summary,
      topics: yield* decodeJson(Strings, row.topics_json),
      throughSequence: row.through_sequence,
      runId: row.run_id,
      updatedAt: row.updated_at
    } satisfies ChatSummary
  })

  const setChat = Effect.fn("SqliteSummaryStore.setChat")(
    function* (input: Parameters<SummaryStore["Service"]["setChat"]>[0]) {
      const now = DateTime.formatIso(yield* DateTime.now)
      yield* writer.run(sql`
        INSERT INTO chat_summaries (session_id, title, summary, topics_json, through_sequence, run_id, updated_at)
        VALUES (${input.sessionId}, ${input.title}, ${input.summary}, ${JSON.stringify(input.topics)},
                ${input.throughSequence}, ${input.runId}, ${now})
        ON CONFLICT (session_id) DO UPDATE SET
          title = excluded.title, summary = excluded.summary, topics_json = excluded.topics_json,
          through_sequence = excluded.through_sequence, run_id = excluded.run_id, updated_at = excluded.updated_at
        WHERE excluded.through_sequence >= chat_summaries.through_sequence
      `)
    },
    Effect.mapError(failure("set_chat", "Could not save the chat summary"))
  )

  const chats = Effect.fn("SqliteSummaryStore.chats")(
    function* (sessionIds: ReadonlyArray<string>) {
      if (sessionIds.length === 0) return new Map<string, ChatSummary>()
      const rows = yield* sql<ChatSummaryRow>`
        SELECT c.session_id, s.public_ref, s.name, s.space_id, s.last_activity, c.title, c.summary,
               c.topics_json, c.through_sequence, c.run_id, c.updated_at
        FROM chat_summaries AS c JOIN sessions AS s USING (session_id)
        WHERE c.session_id IN ${sql.in(sessionIds)}
      `
      const summaries = yield* Effect.forEach(rows, chatSummary)
      return new Map(summaries.map((summary) => [summary.sessionId, summary]))
    },
    Effect.mapError(failure("chat", "Could not read the chat summary"))
  )

  const chat = (sessionId: string) =>
    chats([sessionId]).pipe(Effect.map((found) => found.get(sessionId) ?? null))

  const spaceChats = Effect.fn("SqliteSummaryStore.spaceChats")(
    function* (spaceId: string) {
      const rows = yield* sql<ChatSummaryRow>`
        SELECT c.session_id, s.public_ref, s.name, s.space_id, s.last_activity, c.title, c.summary,
               c.topics_json, c.through_sequence, c.run_id, c.updated_at
        FROM chat_summaries AS c JOIN sessions AS s USING (session_id)
        WHERE s.space_id = ${spaceId} AND s.archived_at IS NULL
        ORDER BY s.last_activity DESC
      `
      return yield* Effect.forEach(rows, chatSummary)
    },
    Effect.mapError(failure("space_chats", "Could not read the Space's chat summaries"))
  )

  const overviewInput = (spaceId: string) =>
    writer
      .snapshot(spaceOverviewInput(reader, spaceId))
      .pipe(Effect.mapError(failure("overview_input", "Could not read Space overview sources")))

  const setSpace = Effect.fn("SqliteSummaryStore.setSpace")(
    function* (input: Parameters<SummaryStore["Service"]["setSpace"]>[0]) {
      const now = DateTime.formatIso(yield* DateTime.now)
      return yield* writer.transact(
        Effect.gen(function* () {
          const current = yield* spaceOverviewInput(sql, input.spaceId)
          if (current === null || current.fingerprint !== input.sourcesFingerprint) return false
          const old = (yield* sql<{
            readonly now: string
            readonly next_json: string
            readonly recent: string | null
            readonly sources_fingerprint: string
            readonly updated_at: string
            readonly revision_id: number | null
          }>`SELECT now, next_json, recent, sources_fingerprint, updated_at, revision_id
            FROM space_summaries WHERE space_id = ${input.spaceId}`)[0]
          if ((old?.revision_id ?? null) !== input.expectedRevisionId) return false
          if (old !== undefined && old.revision_id !== null) {
            const recorded = (yield* sql<{
              readonly system_prompt_hash: string | null
              readonly user_prompt: string | null
            }>`SELECT system_prompt_hash, user_prompt FROM space_overview_revisions
              WHERE revision_id = ${old.revision_id}`)[0]
            if (
              old.sources_fingerprint === input.sourcesFingerprint &&
              recorded?.system_prompt_hash === input.systemPromptHash &&
              recorded.user_prompt === input.userPrompt
            )
              return false
          }
          if (old !== undefined && old.revision_id === null) {
            yield* sql`INSERT INTO space_overview_revisions
              (space_id, kind, now, next_json, recent, sources_fingerprint, generated_at, recorded_at)
              VALUES (${input.spaceId}, 'baseline', ${old.now}, ${old.next_json}, ${old.recent},
                ${old.sources_fingerprint}, ${old.updated_at}, ${now})`
          }
          yield* sql`INSERT INTO space_overview_revisions
            (space_id, kind, now, next_json, recent, sources_fingerprint, source_refs_json,
              user_prompt, system_prompt_hash, trigger_automation_run_id, trigger_chat_run_id,
              generated_at, recorded_at)
            VALUES (${input.spaceId}, 'generated', ${input.now}, ${JSON.stringify(input.next)},
              ${input.recent}, ${input.sourcesFingerprint}, ${JSON.stringify(
                current.chats.map((chat) => ({
                  sessionId: chat.sessionId,
                  throughSequence: chat.throughSequence,
                  runId: chat.runId
                }))
              )},
              ${input.userPrompt}, ${input.systemPromptHash}, ${input.triggerAutomationRunId},
              ${input.triggerChatRunId}, ${now}, ${now})`
          const inserted = (yield* sql<{
            readonly id: number
          }>`SELECT last_insert_rowid() AS id`)[0]
          if (inserted === undefined) throw new Error("Missing Space overview revision")
          yield* sql`INSERT INTO space_summaries
            (space_id, now, next_json, recent, sources_fingerprint, updated_at, revision_id)
            VALUES (${input.spaceId}, ${input.now}, ${JSON.stringify(input.next)}, ${input.recent},
              ${input.sourcesFingerprint}, ${now}, ${inserted.id})
            ON CONFLICT (space_id) DO UPDATE SET
              now = excluded.now, next_json = excluded.next_json, recent = excluded.recent,
              sources_fingerprint = excluded.sources_fingerprint, updated_at = excluded.updated_at,
              revision_id = excluded.revision_id`
          return true
        })
      )
    },
    Effect.mapError(failure("set_space", "Could not save the Space summary"))
  )

  const space = Effect.fn("SqliteSummaryStore.space")(
    function* (spaceId: string) {
      return yield* writer.snapshot(
        Effect.gen(function* () {
          const rows = yield* reader<{
            readonly now: string
            readonly next_json: string
            readonly recent: string | null
            readonly sources_fingerprint: string
            readonly updated_at: string
            readonly revision_id: number | null
            readonly system_prompt_hash: string | null
            readonly user_prompt: string | null
          }>`SELECT summary.now, summary.next_json, summary.recent, summary.sources_fingerprint,
          summary.updated_at, summary.revision_id, revision.system_prompt_hash, revision.user_prompt
        FROM space_summaries AS summary
        LEFT JOIN space_overview_revisions AS revision ON revision.revision_id = summary.revision_id
        WHERE summary.space_id = ${spaceId}`
          const row = rows[0]
          if (row === undefined) return null
          const current = yield* spaceOverviewInput(reader, spaceId)
          return {
            spaceId,
            now: row.now,
            next: yield* decodeJson(Strings, row.next_json),
            recent: row.recent,
            sourcesFingerprint: row.sources_fingerprint,
            updatedAt: row.updated_at,
            revisionId: row.revision_id,
            sourceFreshness: overviewSourceFreshness(
              row.revision_id,
              row.sources_fingerprint,
              current?.fingerprint ?? null
            ),
            systemPromptHash: row.system_prompt_hash,
            userPrompt: row.user_prompt
          }
        })
      )
    },
    Effect.mapError(failure("space", "Could not read the Space summary"))
  )

  const spaceHistory = Effect.fn("SqliteSummaryStore.spaceHistory")(
    function* (spaceId: string, after: number, limit: number) {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        return yield* new SummaryStoreError({
          operation: "space_history",
          reason: "invalid",
          message: "Invalid history window"
        })
      return yield* writer.snapshot(
        Effect.gen(function* () {
          const owner = yield* reader<{ readonly space_id: string }>`
        SELECT space_id FROM spaces WHERE space_id = ${spaceId}`
          if (owner.length === 0)
            return yield* new SummaryStoreError({
              operation: "space_history",
              reason: "not_found",
              message: "Space does not exist"
            })
          const current = (yield* reader<{ readonly revision_id: number | null }>`
        SELECT revision_id FROM space_summaries WHERE space_id = ${spaceId}`)[0]
          const first = (yield* reader<{ readonly kind: "baseline" | "generated" }>`
        SELECT kind FROM space_overview_revisions WHERE space_id = ${spaceId}
        ORDER BY revision_id LIMIT 1`)[0]
          let coverage: "pending_baseline" | "from_baseline" | "from_creation" = "from_creation"
          if (current?.revision_id === null) coverage = "pending_baseline"
          else if (first?.kind === "baseline") coverage = "from_baseline"
          const rows = yield* reader<{
            readonly revision_id: number
            readonly space_id: string
            readonly kind: "baseline" | "generated"
            readonly now: string
            readonly next_json: string
            readonly recent: string | null
            readonly sources_fingerprint: string
            readonly source_refs_json: string | null
            readonly user_prompt: string | null
            readonly system_prompt_hash: string | null
            readonly trigger_automation_run_id: number | null
            readonly trigger_chat_run_id: string | null
            readonly generated_at: string
            readonly recorded_at: string
          }>`SELECT * FROM space_overview_revisions WHERE space_id = ${spaceId}
        AND revision_id > ${after} ORDER BY revision_id LIMIT ${limit + 1}`
          const entries = yield* Effect.forEach(
            rows.slice(0, limit),
            Effect.fn("SqliteSummaryStore.spaceHistoryRow")(function* (row): Effect.fn.Return<
              SpaceOverviewRevision,
              unknown
            > {
              return {
                revisionId: row.revision_id,
                spaceId: row.space_id,
                kind: row.kind,
                now: row.now,
                next: yield* decodeJson(Strings, row.next_json),
                recent: row.recent,
                sourcesFingerprint: row.sources_fingerprint,
                sourceRefs:
                  row.source_refs_json === null
                    ? null
                    : yield* decodeJson(SourceRefs, row.source_refs_json),
                userPrompt: row.user_prompt,
                systemPromptHash: row.system_prompt_hash,
                triggerAutomationRunId: row.trigger_automation_run_id,
                triggerChatRunId: row.trigger_chat_run_id,
                generatedAt: row.generated_at,
                recordedAt: row.recorded_at
              }
            })
          )
          return {
            entries,
            next_after_revision: rows.length > limit ? (entries.at(-1)?.revisionId ?? null) : null,
            coverage
          }
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof SummaryStoreError
        ? cause
        : failure("space_history", "Could not read Space overview history")(cause)
    )
  )

  return SummaryStore.of({
    setChat,
    chat,
    chats,
    spaceChats,
    overviewInput,
    setSpace,
    space,
    spaceHistory
  })
}
