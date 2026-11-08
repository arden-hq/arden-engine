import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import type { StoragePolicyStore } from "../storage/store.js"
import { StorageStartupError } from "../service.js"
import { decodeJson, encodeJson } from "./json.js"
import { transcriptSearchText } from "../transcript/search-text.js"
import { JsonObjectSchema } from "../json.js"
import { rebuildSessionTurns } from "./turns.js"
import { replaceActiveContext } from "./active-context.js"
import { sessionActiveWorkSql } from "./work-retention.js"
import { latestSessionRunQuery } from "./session-latest-run.js"
import { deleteRunSidecarsBySessionInTransaction } from "./run-sidecar-mutations.js"
import type { PersistenceDeps } from "./deps.js"
import { isTerminalRunStatus } from "@arden-hq/protocol/runs"

const RETENTION_BATCH_SIZE = 20

const UNUSED_FORK_TRACE_DAYS = 7

interface RetainedRunRow {
  readonly session_id: string
  readonly run_id: string
  readonly turn_id: string | null
  readonly status: string
  readonly assistant_message_id: string
}

interface ExpiredAgentRow extends RetainedRunRow {
  readonly metadata: string | null
}

interface ResultMessageRow {
  readonly seq: number
  readonly message_json: string
}

const retentionError = (cause: unknown): StorageStartupError =>
  new StorageStartupError({
    operation: "initialize",
    message: "Could not compact expired run traces",
    cause
  })

const minimalResult = (message: StoredMessageEnvelope): StoredMessageEnvelope => ({
  message_id: message.message_id,
  role: "assistant",
  created_at: message.created_at,
  ...(message.content === undefined ? {} : { content: message.content })
})

const loadResult = Effect.fn("SqliteAgentRetention.loadResult")(function* (
  sql: SqlClient.SqlClient,
  row: RetainedRunRow
) {
  if (row.status !== "completed") return null
  const messages = yield* sql<ResultMessageRow>`
    SELECT seq, message_json
    FROM session_messages
    WHERE session_id = ${row.session_id}
      AND message_id = ${row.assistant_message_id}
    LIMIT 1
  `
  const stored = messages[0]
  if (stored === undefined) {
    return yield* retentionError(
      new Error(`Completed Session ${row.session_id} has no final result`)
    )
  }
  const decoded = yield* decodeJson(StoredMessageEnvelopeSchema, stored.message_json)
  if (decoded.role !== "assistant") {
    return yield* retentionError(
      new Error(`Completed Session ${row.session_id} has an invalid final result`)
    )
  }
  return { message: minimalResult(decoded), previousSequence: stored.seq }
})

export const compactExpiredAgentSessions = Effect.fn(
  "SqliteAgentRetention.compactExpiredAgentSessions"
)(function* ({
  writer,
  sessionEvents,
  policy
}: Pick<PersistenceDeps, "writer" | "sessionEvents"> & {
  readonly policy: StoragePolicyStore["Service"]
}) {
  const sql = writer.sql
  const expired = Effect.fn("SqliteAgentRetention.expired")(function* (sessionId?: string) {
    const retention = yield* policy.retention()
    const now = yield* DateTime.now
    const agentCutoff =
      retention.agentTraceDays === null
        ? null
        : DateTime.formatIso(DateTime.subtract(now, { days: retention.agentTraceDays }))
    const forkCutoff = DateTime.formatIso(DateTime.subtract(now, { days: UNUSED_FORK_TRACE_DAYS }))
    return yield* sql<ExpiredAgentRow>`
      -- Cheap filters first, materialized: each agent's latest Run comes from
      -- the index, and the live-work checks below run only for expired agents
      -- whose latest Run is not yet retained, never for every agent.
      WITH expired AS MATERIALIZED (
        SELECT s.session_id, s.public_ref, s.metadata, run.run_id, run.ended_at
        FROM sessions AS s
        JOIN chat_runs AS run ON run.run_id = (${sql.literal(latestSessionRunQuery)})
        WHERE ${sessionId === undefined ? sql`1` : sql`s.session_id = ${sessionId}`} AND (
            (s.session_type = 'agent' AND run.ended_at <= ${agentCutoff})
            OR (s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
              AND s.origin_automation_id IS NOT NULL
              AND COALESCE(json_type(s.metadata, '$.fork_origin'),
                json_type(s.metadata, '$.fork_of')) IS NOT NULL
              AND run.ended_at <= ${forkCutoff})
          )
          AND COALESCE(
            json_extract(s.metadata, '$.agent_trace_retained_run_id'),
            ''
          ) <> run.run_id
      )
      SELECT session.session_id, session.metadata, run.run_id,
             json_extract(run.metadata_json, '$.turn_id') AS turn_id, run.status,
             run.assistant_message_id
      FROM expired AS session
      JOIN chat_runs AS run ON run.run_id = session.run_id
      WHERE NOT ${sessionActiveWorkSql(sql, "session")}
      ORDER BY session.ended_at, session.session_id
      LIMIT ${RETENTION_BATCH_SIZE}
    `
  })
  const rows = yield* writer.run(expired()).pipe(Effect.mapError(retentionError))
  const retainedSessionIds: Array<string> = []
  const history: Array<{ sessionId: string; retainedSequence: number }> = []

  for (const candidate of rows) {
    const retained = yield* writer
      .transact(
        Effect.gen(function* () {
          const [row] = yield* expired(candidate.session_id)
          if (row === undefined || row.run_id !== candidate.run_id) return null
          const retainedAt = DateTime.formatIso(yield* DateTime.now)
          if (!isTerminalRunStatus(row.status)) {
            return yield* retentionError(
              new Error(`Session ${row.session_id} has invalid terminal state ${row.status}`)
            )
          }
          if (row.turn_id === null || row.turn_id.length === 0) {
            return yield* retentionError(
              new Error(`Session ${row.session_id} has no durable turn id`)
            )
          }
          const runs = yield* sql<RetainedRunRow>`
          SELECT session_id, run_id, status, assistant_message_id,
                 json_extract(metadata_json, '$.turn_id') AS turn_id
          FROM chat_runs WHERE session_id = ${row.session_id}
          ORDER BY started_at, run_id
        `
          const results = yield* Effect.forEach(
            runs,
            Effect.fn("SqliteAgentRetention.results.run")(function* (run) {
              if (run.turn_id === null || run.turn_id.length === 0) {
                return yield* retentionError(new Error(`Run ${run.run_id} has no durable turn id`))
              }
              const result = yield* loadResult(sql, run)
              return result === null ? [] : [{ ...result.message, turn_id: run.turn_id }]
            })
          )
          const projection = results.flat()
          const metadata = yield* decodeJson(JsonObjectSchema, row.metadata ?? "{}")
          const agent = metadata["agent"]
          const forkOrigin = metadata["fork_origin"]
          const legacyFork = metadata["fork_of"]
          const metadataJson = yield* encodeJson(JsonObjectSchema, {
            ...(agent === undefined ? {} : { agent }),
            ...(forkOrigin === undefined ? {} : { fork_origin: forkOrigin }),
            ...(forkOrigin === undefined && legacyFork !== undefined
              ? { fork_of: legacyFork }
              : {}),
            agent_trace_retained_at: retainedAt,
            agent_trace_retained_run_id: row.run_id
          })
          yield* sql`DELETE FROM chat_idempotency_keys WHERE session_id = ${row.session_id}`
          yield* deleteRunSidecarsBySessionInTransaction(sql, row.session_id)
          yield* sql`DELETE FROM chat_compactions WHERE session_id = ${row.session_id}`
          yield* sql`DELETE FROM session_todos WHERE session_id = ${row.session_id}`
          yield* sql`DELETE FROM session_turns WHERE session_id = ${row.session_id}`
          yield* sql`DELETE FROM session_messages WHERE session_id = ${row.session_id}`
          yield* sql`DELETE FROM tool_calls WHERE session_id = ${row.session_id}`

          for (const [sequence, seedMessage] of projection.entries()) {
            const messageJson = yield* encodeJson(StoredMessageEnvelopeSchema, seedMessage)
            yield* sql`
            INSERT INTO session_messages (
              session_id, message_id, seq, role, message_json, client_id,
              created_at, search_text
            ) VALUES (
              ${row.session_id}, ${seedMessage.message_id}, ${sequence}, 'assistant',
              ${messageJson}, NULL, ${seedMessage.created_at},
              ${transcriptSearchText(seedMessage)}
            )
          `
          }
          yield* rebuildSessionTurns(sql, row.session_id)

          yield* sql`
          UPDATE sessions
          SET metadata = ${metadataJson}, context_generation = context_generation + 1
          WHERE session_id = ${row.session_id}
        `
          yield* replaceActiveContext(sql, row.session_id, projection)
          yield* sql`
          UPDATE chat_runs
          SET metadata_json = json_object('turn_id', json_extract(metadata_json, '$.turn_id'),
                'run_context', json_extract(metadata_json, '$.run_context'),
                'run_policy', json_extract(metadata_json, '$.run_policy'),
                'terminal_result', json_extract(metadata_json, '$.terminal_result'),
                'accounted_usage', json_extract(metadata_json, '$.accounted_usage'),
                'late_result_at', json_extract(metadata_json, '$.late_result_at'),
                'no_change_reason', json_extract(metadata_json, '$.no_change_reason'),
                'trace_removed_at', json_extract(metadata_json, '$.trace_removed_at')),
              client_id = NULL
          WHERE session_id = ${row.session_id}
        `
          const activity = yield* sessionEvents.appendInTransaction(
            "session_activity",
            row.session_id
          )
          const retainedSequence = activity.records.at(-1)?.sequence
          if (retainedSequence === undefined) {
            return yield* retentionError(
              new Error(`Session ${row.session_id} retained no lifecycle activity`)
            )
          }
          return { retainedSequence }
        })
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Skipping a Session whose trace could not be retained", {
            sessionId: candidate.session_id,
            runId: candidate.run_id,
            cause
          }).pipe(Effect.as(null))
        )
      )
    if (retained !== null) {
      retainedSessionIds.push(candidate.session_id)
      history.push({ sessionId: candidate.session_id, retainedSequence: retained.retainedSequence })
    }
  }
  yield* sessionEvents
    .pruneSessionHistory(history)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not prune lifecycle snapshots of retained Sessions", { cause })
      )
    )
  return retainedSessionIds.length
})
