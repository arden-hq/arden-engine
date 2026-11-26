import { DateTime, Effect, Schema } from "effect"
import { SummaryStore, SummaryStoreError, type ChatSummary } from "../summaries/store.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"

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
const failure =
  (operation: SummaryStoreError["operation"], message: string) =>
  (cause: unknown): SummaryStoreError =>
    new SummaryStoreError({ operation, reason: "storage", message, cause })

export const makeSummaryStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): SummaryStore["Service"] => {
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
      const saved = yield* writer.run(sql<{ readonly session_id: string }>`
        INSERT INTO chat_summaries (session_id, title, summary, topics_json, through_sequence, run_id, updated_at)
        VALUES (${input.sessionId}, ${input.title}, ${input.summary}, ${JSON.stringify(input.topics)},
                ${input.throughSequence}, ${input.runId}, ${now})
        ON CONFLICT (session_id) DO UPDATE SET
          title = excluded.title, summary = excluded.summary, topics_json = excluded.topics_json,
          through_sequence = excluded.through_sequence, run_id = excluded.run_id, updated_at = excluded.updated_at
        WHERE excluded.through_sequence >= chat_summaries.through_sequence
        RETURNING session_id
      `)
      return saved.length > 0
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

  return SummaryStore.of({
    setChat,
    chat,
    chats
  })
}
