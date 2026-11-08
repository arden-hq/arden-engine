import { journalRunIdSql } from "./journal-run-boundary.js"
import { isActiveRunStatus, type RunProgress } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { journalRecordsSql } from "@arden-hq/journal/effect"
import { RunDataCorruptionError, RunQueryError, type RunQueries } from "../runs/queries.js"
import { decodeJson } from "./json.js"
import type { Writer } from "./deps.js"

const ActivityEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("TOOL_CALL_START"),
    tool_call_id: Schema.NonEmptyString,
    title: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literals(["TOOL_CALL_END", "TOOL_CALL_RESULT"]),
    tool_call_id: Schema.NonEmptyString
  }),
  Schema.Struct({
    type: Schema.Literal("model_response_reset"),
    tool_call_ids: Schema.Array(Schema.NonEmptyString)
  })
])

export const makeRunProgressQuery = ({
  sql,
  get,
  snapshot
}: {
  readonly sql: SqlClient.SqlClient
  readonly get: RunQueries["Service"]["get"]
  readonly snapshot: Writer["snapshot"]
}): RunQueries["Service"]["progress"] =>
  Effect.fn("SqliteRunQueries.progress")(
    function* (runId: string) {
      const run = yield* get(runId)
      if (run === null) return null
      const checkpoint = run.lastSequence ?? 0
      const [newest] = yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM ${journalRecordsSql(sql)}
    WHERE stream_id = ${run.sessionId} AND sequence > ${checkpoint}
      AND ${journalRunIdSql(sql)} = ${run.runId}
    ORDER BY sequence DESC LIMIT 1
  `
      const base = {
        run_id: run.runId,
        session_id: run.sessionId,
        status: run.status,
        started_at: DateTime.formatIso(run.startedAt),
        through_sequence: Math.max(newest?.sequence ?? 0, checkpoint),
        trace_removed: run.metadata.trace_removed_at != null
      }
      if (base.trace_removed || !isActiveRunStatus(run.status)) {
        return { ...base, active_tools: [] } satisfies RunProgress
      }
      const rows = yield* sql<{ readonly data_json: string }>`
    SELECT CASE WHEN event_type = 'model_response_reset'
      THEN json_object('type', event_type, 'tool_call_ids', json_extract(data_json, '$.tool_call_ids'))
      ELSE json_object('type', event_type, 'tool_call_id', json_extract(data_json, '$.tool_call_id'),
        'title', json_extract(data_json, '$.display_title')) END AS data_json
    FROM ${journalRecordsSql(sql)}
    WHERE stream_id = ${run.sessionId}
      AND sequence <= ${base.through_sequence}
      AND sequence >= COALESCE((
        SELECT sequence FROM ${journalRecordsSql(sql)}
        WHERE stream_id = ${run.sessionId} AND sequence <= ${base.through_sequence}
          AND event_type = 'RUN_STARTED'
          AND ${journalRunIdSql(sql)} = ${run.runId}
        ORDER BY sequence DESC LIMIT 1
      ), 0)
      AND ${journalRunIdSql(sql)} = ${run.runId}
      AND event_type IN ('TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'model_response_reset')
    ORDER BY sequence ASC
  `
      const active = new Map<string, RunProgress["active_tools"][number]>()
      for (const row of rows) {
        const event = yield* decodeJson(ActivityEventSchema, row.data_json).pipe(
          Effect.mapError(
            (cause) =>
              new RunDataCorruptionError({ runId, message: "Run activity is corrupt", cause })
          )
        )
        switch (event.type) {
          case "TOOL_CALL_START":
            active.set(event.tool_call_id, { tool_call_id: event.tool_call_id, title: event.title })
            break
          case "TOOL_CALL_END":
          case "TOOL_CALL_RESULT":
            active.delete(event.tool_call_id)
            break
          case "model_response_reset":
            for (const id of event.tool_call_ids) active.delete(id)
            break
        }
      }
      return { ...base, active_tools: [...active.values()] } satisfies RunProgress
    },
    snapshot,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new RunQueryError({
          operation: "progress",
          message: "Could not read Run activity",
          cause
        })
      )
    )
  )

const WaitingEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["TOOL_CALL_WAITING", "TOOL_CALL_START", "TOOL_CALL_RESULT"]),
    tool_call_id: Schema.NonEmptyString
  }),
  Schema.Struct({
    type: Schema.Literal("model_response_reset"),
    tool_call_ids: Schema.Array(Schema.NonEmptyString)
  })
])

type WaitingEvent = (typeof WaitingEventSchema)["Type"]

const foldWaitingToolCalls = (events: ReadonlyArray<WaitingEvent>): ReadonlyArray<string> => {
  const waiting = new Set<string>()
  for (const event of events) {
    switch (event.type) {
      case "TOOL_CALL_WAITING":
        waiting.add(event.tool_call_id)
        break
      case "TOOL_CALL_START":
      case "TOOL_CALL_RESULT":
        waiting.delete(event.tool_call_id)
        break
      case "model_response_reset":
        for (const id of event.tool_call_ids) waiting.delete(id)
        break
    }
  }
  return [...waiting]
}

export const makeWaitingToolCallsQuery = ({
  sql,
  get
}: {
  readonly sql: SqlClient.SqlClient
  readonly get: RunQueries["Service"]["get"]
}): RunQueries["Service"]["waitingToolCalls"] =>
  Effect.fn("SqliteRunQueries.waitingToolCalls")(
    function* (runId: string) {
      const run = yield* get(runId)
      if (run === null || !isActiveRunStatus(run.status)) return []
      const rows = yield* sql<{ readonly data_json: string }>`
    SELECT CASE WHEN event_type = 'model_response_reset'
      THEN json_object('type', event_type, 'tool_call_ids', json_extract(data_json, '$.tool_call_ids'))
      ELSE json_object('type', event_type, 'tool_call_id', json_extract(data_json, '$.tool_call_id')) END AS data_json
    FROM ${journalRecordsSql(sql)}
    WHERE stream_id = ${run.sessionId}
      AND sequence >= COALESCE((
        SELECT sequence FROM ${journalRecordsSql(sql)}
        WHERE stream_id = ${run.sessionId}
          AND event_type = 'RUN_STARTED'
          AND ${journalRunIdSql(sql)} = ${run.runId}
        ORDER BY sequence DESC LIMIT 1
      ), 0)
      AND ${journalRunIdSql(sql)} = ${run.runId}
      AND event_type IN ('TOOL_CALL_WAITING', 'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'model_response_reset')
    ORDER BY sequence ASC
  `
      const events: Array<WaitingEvent> = []
      for (const row of rows) {
        events.push(
          yield* decodeJson(WaitingEventSchema, row.data_json).pipe(
            Effect.mapError(
              (cause) =>
                new RunDataCorruptionError({ runId, message: "Run activity is corrupt", cause })
            )
          )
        )
      }
      return foldWaitingToolCalls(events)
    },
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new RunQueryError({
          operation: "progress",
          message: "Could not read the Run's waiting calls",
          cause
        })
      )
    )
  )
