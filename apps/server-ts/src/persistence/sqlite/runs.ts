import { journalRunIdSql } from "./journal-run-boundary.js"
import { readRunAuthority } from "./run-authority.js"
import { readCause } from "./run-cause.js"
import { readChatWork } from "./chat-work.js"
import { makeRunProgressQuery, makeWaitingToolCallsQuery } from "./run-progress.js"
import { runGoogleAccounts } from "./run-google-accounts.js"
import { readRunLiveness } from "./run-liveness.js"
import { ChatProjectionEventSchema } from "@arden-hq/protocol/effect/chat"
import { DateTime, Effect, Schema } from "effect"
import { journalRecordsSql } from "@arden-hq/journal/effect"
import { ChatRunRecordSchema } from "../runs/model.js"
import { JsonObjectSchema } from "../json.js"
import { makeSessionRunQueries } from "./run-session-queries.js"
import {
  type ActiveRunSnapshot,
  ActiveRunSnapshotSchema,
  type RunEventPageInput,
  type RunEventPageRecord,
  RunDataCorruptionError,
  RunQueries,
  RunQueryError
} from "../runs/queries.js"
import { decodeJson } from "./json.js"
import type { PersistenceDeps } from "./deps.js"
import { activeRunStatusList } from "./status-sets.js"
import { runAncestors } from "./tree-walk.js"
import { parkedOnQuota, quotaPauseUntil } from "./run-wait.js"

interface RunRow {
  readonly run_id: string
  readonly session_id: string
  readonly turn_id: string | null
  readonly status: string
  readonly stop_reason: string | null
  readonly started_at: string
  readonly updated_at: string
  readonly ended_at: string | null
  readonly last_seq: number | null
  readonly metadata_json: string
  readonly error_code: string | null
  readonly error_message: string | null
  readonly client_id: string | null
  readonly model_id: string | null
  readonly reasoning_effort: string | null
}

interface RunEventRow {
  readonly sequence: number
  readonly event_type: string
  readonly data_json: string
  readonly created_at: string
}

interface ActiveRunListRow {
  readonly total_retained: number
  readonly run_id: string | null
  readonly session_id: string | null
  readonly turn_id: string | null
  readonly status: string | null
  readonly started_at: string | null
  readonly updated_at: string | null
  readonly message_count: number | null
  readonly pending_injections: number | null
  readonly approvals_pending: number | null
}

const queryError = (
  operation: "get" | "latest_for_session" | "active" | "events",
  message: string,
  cause?: unknown
) =>
  new RunQueryError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const corruption = (runId: string, message: string, cause?: unknown) =>
  new RunDataCorruptionError({
    runId,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const makeRunQueries = ({
  reader,
  writer
}: Pick<PersistenceDeps, "reader" | "writer">): RunQueries["Service"] => {
  const sql = reader
  const decode = Effect.fn("SqliteRunQueries.decode")(function* (row: RunRow) {
    if (row.turn_id === null || row.turn_id.length === 0) {
      return yield* corruption(row.run_id, "Run has no durable turn id")
    }
    const startedAt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
      row.started_at
    ).pipe(Effect.mapError((cause) => corruption(row.run_id, "Run started_at is corrupt", cause)))
    const updatedAt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
      row.updated_at
    ).pipe(Effect.mapError((cause) => corruption(row.run_id, "Run updated_at is corrupt", cause)))
    const endedAt = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.DateTimeUtcFromString))(
      row.ended_at
    ).pipe(Effect.mapError((cause) => corruption(row.run_id, "Run ended_at is corrupt", cause)))
    const metadata = yield* decodeJson(JsonObjectSchema, row.metadata_json).pipe(
      Effect.mapError((cause) => corruption(row.run_id, "Run metadata is corrupt", cause))
    )
    return yield* Schema.decodeUnknownEffect(ChatRunRecordSchema)({
      runId: row.run_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      status: row.status,
      stopReason: row.stop_reason,
      startedAt,
      updatedAt,
      endedAt,
      lastSequence: row.last_seq,
      metadata,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      clientId: row.client_id,
      modelId: row.model_id,
      reasoningEffort: row.reasoning_effort
    }).pipe(Effect.mapError((cause) => corruption(row.run_id, "Run row is corrupt", cause)))
  })

  const get = Effect.fn("SqliteRunQueries.get")(function* (runId: string) {
    const rows = yield* sql<RunRow>`
      SELECT run_id, session_id,
             json_extract(metadata_json, '$.turn_id') AS turn_id,
             status, stop_reason, started_at, updated_at,
             ended_at, last_seq, metadata_json, error_code, error_message, client_id,
             model_id, reasoning_effort
      FROM chat_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `.pipe(Effect.mapError((cause) => queryError("get", "Could not load run", cause)))
    const [row] = rows
    return row === undefined ? null : yield* decode(row)
  })

  const turnsOfRuns = Effect.fn("SqliteRunQueries.turnsOfRuns")(function* (
    runIds: ReadonlyArray<string>
  ) {
    if (runIds.length === 0) return new Map<string, string>()
    const rows = yield* sql<{
      readonly origin: string
      readonly depth: number
      readonly turn_id: string | null
      readonly parent_run_id: string | null
    }>`
      WITH RECURSIVE ${runAncestors(sql, {
        name: "chain",
        from: sql`SELECT run_id FROM chat_runs WHERE run_id IN ${sql.in([...new Set(runIds)])}`,
        depth: { max: 16 },
        root: true
      })}
      SELECT chain.root_run_id AS origin, chain.depth,
             json_extract(run.metadata_json, '$.turn_id') AS turn_id,
             agent.parent_run_id
      FROM chain
      JOIN chat_runs AS run ON run.run_id = chain.run_id
      JOIN sessions AS agent ON agent.session_id = run.session_id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            operation: "output_turns",
            message: "Could not resolve the turns of runs",
            cause
          })
      )
    )
    const top = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      const known = top.get(row.origin)
      if (known === undefined || row.depth > known.depth) top.set(row.origin, row)
    }
    return new Map(
      [...top].flatMap(([runId, row]) =>
        row.turn_id === null || row.parent_run_id !== null ? [] : [[runId, row.turn_id] as const]
      )
    )
  })

  const latestForSession = Effect.fn("SqliteRunQueries.latestForSession")(function* (
    sessionId: string
  ) {
    const rows = yield* sql<RunRow>`
      SELECT run_id, session_id,
             json_extract(metadata_json, '$.turn_id') AS turn_id,
             status, stop_reason, started_at, updated_at,
             ended_at, last_seq, metadata_json, error_code, error_message, client_id,
             model_id, reasoning_effort
      FROM chat_runs
      WHERE session_id = ${sessionId}
      ORDER BY updated_at DESC, started_at DESC, run_id DESC
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        queryError("latest_for_session", "Could not load latest session run", cause)
      )
    )
    const [row] = rows
    return row === undefined ? null : yield* decode(row)
  })

  const activeSnapshot = Effect.fn("SqliteRunQueries.activeSnapshot")(function* (runId?: string) {
    const rows = yield* sql<ActiveRunListRow>`
      WITH active_runs AS (
        SELECT r.run_id, r.session_id,
               json_extract(r.metadata_json, '$.turn_id') AS turn_id,
               r.status, r.started_at, r.updated_at,
               s.active_message_count AS message_count,
               (
                 SELECT COUNT(*)
                 FROM chat_idempotency_keys AS injection
                 WHERE injection.run_id = r.run_id AND injection.status = 'queued'
               ) AS pending_injections,
               (
                 SELECT COUNT(*)
                 FROM tool_approvals AS approval
                 WHERE approval.run_id = r.run_id AND approval.status = 'pending'
               ) AS approvals_pending
        FROM chat_runs AS r
        LEFT JOIN sessions AS s ON s.session_id = r.session_id
        WHERE r.status IN ${activeRunStatusList}
          ${runId === undefined ? sql`` : sql`AND r.run_id = ${runId}`}
      )
      SELECT totals.total_retained, active_runs.*
      FROM (SELECT COUNT(*) AS total_retained FROM chat_runs
        ${runId === undefined ? sql`` : sql`WHERE run_id = ${runId}`}) AS totals
      LEFT JOIN active_runs ON TRUE
      ORDER BY active_runs.started_at ASC, active_runs.run_id ASC
    `.pipe(Effect.mapError((cause) => queryError("active", "Could not list active runs", cause)))
    const totalRetained = yield* Schema.decodeUnknownEffect(Schema.Natural)(
      rows[0]?.total_retained
    ).pipe(Effect.mapError((cause) => queryError("active", "Run count is corrupt", cause)))
    const runs: Array<ActiveRunSnapshot> = []
    for (const row of rows) {
      const runId = row.run_id
      if (runId === null) continue
      if (row.turn_id === null || row.turn_id.length === 0) {
        return yield* corruption(runId, "Active run has no durable turn id")
      }
      runs.push(
        yield* Schema.decodeUnknownEffect(ActiveRunSnapshotSchema)({
          runId,
          sessionId: row.session_id,
          turnId: row.turn_id,
          status: row.status,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          messageCount: row.message_count,
          pendingInjections: row.pending_injections,
          approvalsPending: row.approvals_pending
        }).pipe(Effect.mapError((cause) => corruption(runId, "Active run row is corrupt", cause)))
      )
    }
    return { totalRetained, runs }
  })

  const events = Effect.fn("SqliteRunQueries.events")(
    function* (input: RunEventPageInput) {
      const run = yield* get(input.runId)
      if (run === null) return null
      const traceRemovedAt = yield* Schema.decodeUnknownEffect(
        Schema.NullOr(Schema.DateTimeUtcFromString)
      )(run.metadata.trace_removed_at ?? null).pipe(
        Effect.mapError((cause) =>
          corruption(run.runId, "Run trace removal timestamp is corrupt", cause)
        )
      )
      const rows = yield* sql<RunEventRow>`
      SELECT sequence, event_type, data_json, created_at
      FROM ${journalRecordsSql(sql)}
      WHERE stream_id = ${run.sessionId}
        AND sequence > ${input.afterSequence}
        AND ${journalRunIdSql(sql)} = ${run.runId}
      ORDER BY sequence ASC
      LIMIT ${input.limit + 1}
    `.pipe(Effect.mapError((cause) => queryError("events", "Could not load Run events", cause)))
      const visible = rows.slice(0, input.limit)
      const decoded = yield* Effect.forEach(
        visible,
        Effect.fn("SqliteRunQueries.decoded.row")(function* (row) {
          const event = yield* decodeJson(ChatProjectionEventSchema, row.data_json).pipe(
            Effect.mapError((cause) => corruption(run.runId, "Run event payload is corrupt", cause))
          )
          if (event.type !== row.event_type) {
            return yield* corruption(run.runId, "Run event type does not match its payload")
          }
          yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(row.created_at).pipe(
            Effect.mapError((cause) =>
              corruption(run.runId, "Run event timestamp is corrupt", cause)
            )
          )
          return {
            sequence: row.sequence,
            createdAt: row.created_at,
            event
          }
        })
      )
      return {
        runId: run.runId,
        sessionId: run.sessionId,
        traceRemovedAt: traceRemovedAt === null ? null : DateTime.formatIso(traceRemovedAt),
        events: decoded,
        nextAfterSequence: decoded.at(-1)?.sequence ?? input.afterSequence,
        hasMore: rows.length > input.limit
      } satisfies RunEventPageRecord
    },
    writer.snapshot,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(queryError("events", "Could not read Run events and retention together", cause))
    )
  )

  const planLimitPauses = Effect.fn("SqliteRunQueries.planLimitPauses")(function* () {
    const rows = yield* sql<{
      readonly run_id: string
      readonly session_id: string
      readonly reason: string
      readonly until: string
      readonly automation_id: string | null
    }>`
      SELECT run_id, session_id,
             json_extract(metadata_json, '$.quota_pause.reason') AS reason,
             ${quotaPauseUntil(sql, sql`metadata_json`)} AS until,
             json_extract(metadata_json, '$.automation.task_id') AS automation_id
      FROM chat_runs
      WHERE ${parkedOnQuota(sql, sql`status`, sql`metadata_json`)}
      ORDER BY until, run_id
      LIMIT 200`.pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            reason: "storage",
            operation: "plan_limit_pauses",
            message: "Could not list runs paused on a plan limit",
            cause
          })
      )
    )
    return rows.map((row) => ({
      runId: row.run_id,
      sessionId: row.session_id,
      reason: row.reason,
      until: row.until,
      automationId: row.automation_id
    }))
  })

  const authority = (runId: string) =>
    readRunAuthority(sql, runId).pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            reason: "storage",
            operation: "get",
            message: "Could not read the Run's authority",
            cause
          })
      )
    )

  const liveness = (runId: string) =>
    readRunLiveness(sql, runId).pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            reason: "storage",
            operation: "get",
            message: "Could not read whether the Run may still act",
            cause
          })
      )
    )

  const cause = (runId: string) =>
    readCause(sql, runId).pipe(
      Effect.mapError(
        (failure) =>
          new RunQueryError({
            reason: "storage",
            operation: "get",
            message: "Could not read what caused the Run",
            cause: failure
          })
      )
    )

  const chatWork = (sessionId: string) =>
    readChatWork(sql, sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new RunQueryError({
            reason: "storage",
            operation: "chat_work",
            message: "Could not read what the chat has running",
            cause
          })
      )
    )

  return RunQueries.of({
    planLimitPauses,
    chatWork,
    authority,
    liveness,
    cause,
    progress: makeRunProgressQuery({ sql, get, snapshot: writer.snapshot }),
    waitingToolCalls: makeWaitingToolCallsQuery({ sql, get }),
    googleAccounts: (runId, service) => runGoogleAccounts(sql, runId, service),
    get,
    turnsOfRuns,
    latestForSession,
    ...makeSessionRunQueries(sql),
    listActive: () => activeSnapshot(),
    active: (runId) => activeSnapshot(runId).pipe(Effect.map((snapshot) => snapshot.runs[0])),
    events
  })
}
