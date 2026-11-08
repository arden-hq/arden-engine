import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatSummary } from "../summaries/store.js"
import { decodeJson } from "./json.js"
import { sha256Hex } from "@arden-hq/std/hash"

interface InputRow {
  readonly space_name: string
  readonly session_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly last_activity: string
  readonly title: string
  readonly summary: string
  readonly topics_json: string
  readonly through_sequence: number
  readonly run_id: string | null
  readonly updated_at: string
}

export const spaceOverviewInput = Effect.fn("SqliteSummaryStore.overviewInput")(function* (
  sql: SqlClient.SqlClient,
  spaceId: string
) {
  const rows = yield* sql<InputRow>`
    SELECT d.name AS space_name, c.session_id, s.public_ref, s.name, s.last_activity,
      c.title, c.summary, c.topics_json, c.through_sequence, c.run_id, c.updated_at
    FROM chat_summaries AS c
    JOIN sessions AS s USING (session_id)
    JOIN spaces AS d ON d.space_id = s.space_id
    WHERE s.space_id = ${spaceId} AND s.archived_at IS NULL
    ORDER BY s.last_activity DESC, s.session_id DESC LIMIT 12`
  const first = rows[0]
  if (first === undefined) return null
  const chats: ReadonlyArray<ChatSummary> = yield* Effect.forEach(
    rows,
    Effect.fn("SqliteSummaryStore.overviewInputRow")(function* (row) {
      return {
        sessionId: row.session_id,
        publicRef: row.public_ref,
        chatName: row.name,
        spaceId,
        lastActivity: row.last_activity,
        title: row.title,
        summary: row.summary,
        topics: yield* decodeJson(Schema.Array(Schema.String), row.topics_json),
        throughSequence: row.through_sequence,
        runId: row.run_id,
        updatedAt: row.updated_at
      }
    })
  )
  return {
    spaceName: first.space_name,
    chats,
    fingerprint: sha256Hex(
      JSON.stringify({
        spaceName: first.space_name,
        sources: rows.map((row) => ({
          sessionId: row.session_id,
          name: row.name,
          lastActivity: row.last_activity,
          title: row.title,
          summary: row.summary,
          topicsJson: row.topics_json,
          throughSequence: row.through_sequence,
          runId: row.run_id
        }))
      })
    )
  }
})
