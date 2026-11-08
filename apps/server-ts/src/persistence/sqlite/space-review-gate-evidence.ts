import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type {
  ChangedChatTurn,
  SpaceReviewGateEvidence,
  GateTurn
} from "../automations/space-review.js"

const MessageContentSchema = Schema.fromJsonString(
  Schema.Struct({ content: Schema.optionalKey(Schema.Unknown) })
)

const messageText = (json: string): string => {
  const content = Option.getOrUndefined(
    Schema.decodeUnknownOption(MessageContentSchema)(json)
  )?.content
  if (Predicate.isString(content)) return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      Predicate.isObject(part) &&
      Predicate.hasProperty(part, "text") &&
      Predicate.isString(part.text)
        ? part.text
        : ""
    )
    .join(" ")
}

const GATE_READ_TURNS = 200

export const readGateEvidence = Effect.fn("SpaceReview.readGateEvidence")(function* (
  sql: SqlClient.SqlClient,
  run: { readonly runId: number; readonly automationId: string },
  changedTurns: ReadonlyArray<ChangedChatTurn>
) {
  const runs = yield* sql<{ readonly trigger_json: string | null }>`
    SELECT trigger_json FROM automation_runs WHERE id = ${run.runId}`
  const held = yield* sql<{ readonly since: string | null }>`
    SELECT MIN(skipped.started_at) AS since
    FROM automation_runs AS skipped
    JOIN scheduled_tasks AS job ON job.task_id = skipped.task_id
    LEFT JOIN space_review_checkpoints AS checkpoint ON checkpoint.space_id = job.owner_space_id
    WHERE skipped.task_id = ${run.automationId}
      AND json_extract(skipped.skip_json, '$.reason') = 'space_review_gate'
      AND (checkpoint.reviewed_at IS NULL
        OR skipped.started_at > checkpoint.reviewed_at)`
  const started = new Map(
    changedTurns.length === 0
      ? []
      : (yield* sql<{ readonly run_id: string; readonly started_at: string }>`
          SELECT run_id, started_at FROM chat_runs
          WHERE run_id IN ${sql.in(changedTurns.map((turn) => turn.runId))}`).map(
          (row) => [row.run_id, row.started_at] as const
        )
  )
  const newestFirst = changedTurns
    .map((turn) => ({ ...turn, startedAt: started.get(turn.runId) ?? "" }))
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
  const trigger = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(AutomationTriggerContextSchema))(
      runs[0]?.trigger_json ?? ""
    )
  )
  const causes = (trigger?.source === "coalesced" ? trigger.causes : [trigger]).filter(
    Predicate.isNotUndefined
  )
  const wokenBy = [
    ...new Set(causes.map((cause) => ("event_type" in cause ? cause.event_type : cause.source)))
  ].sort()
  const titles = new Map<string, string | undefined>()
  const turns: Array<GateTurn> = []
  for (const turn of newestFirst.slice(0, GATE_READ_TURNS)) {
    if (!titles.has(turn.sessionId)) {
      const title = yield* sql<{ readonly title: string | null }>`
        SELECT COALESCE((SELECT title FROM chat_summaries WHERE session_id = ${turn.sessionId}),
          (SELECT name FROM sessions WHERE session_id = ${turn.sessionId})) AS title`
      titles.set(turn.sessionId, title[0]?.title ?? undefined)
    }
    const rows = yield* sql<{
      readonly user_message_id: string
      readonly message_start_seq: number
      readonly message_end_seq: number
    }>`SELECT user_message_id, message_start_seq, message_end_seq FROM session_turns
      WHERE session_id = ${turn.sessionId} AND turn_id = ${turn.turnId}`
    const stored = rows[0]
    if (stored === undefined) continue
    const user = yield* sql<{ readonly message_json: string }>`
      SELECT message_json FROM session_messages
      WHERE session_id = ${turn.sessionId} AND message_id = ${stored.user_message_id}`
    const answer = yield* sql<{ readonly message_json: string }>`
      SELECT message_json FROM session_messages
      WHERE session_id = ${turn.sessionId} AND role = 'assistant'
        AND seq BETWEEN ${stored.message_start_seq} AND ${stored.message_end_seq}
        AND message_json NOT LIKE '%"tool_calls"%'
      ORDER BY seq DESC LIMIT 1`
    turns.push({
      sessionId: turn.sessionId,
      startedAt: turn.startedAt,
      chatTitle: titles.get(turn.sessionId),
      user: user[0] === undefined ? undefined : messageText(user[0].message_json),
      assistant: answer[0] === undefined ? undefined : messageText(answer[0].message_json)
    })
  }
  return {
    wokenBy,
    heldSince: held[0]?.since ?? undefined,
    turns,
    unread: Math.max(0, newestFirst.length - GATE_READ_TURNS)
  } satisfies SpaceReviewGateEvidence
})
