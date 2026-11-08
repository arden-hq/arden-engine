import type {
  RunUsage,
  SessionRunUsage,
  UsageDailyCell,
  UsageReport
} from "@arden-hq/protocol/runs"
import { utcDay as utcDayOf } from "@arden-hq/std/time"
import { DateTime, Effect, Option } from "effect"

import { UsageStore, UsageStoreError, type StoredSessionUsage } from "../usage/store.js"
import { backgroundUsage } from "./usage-background.js"
import type { PersistenceDeps } from "./deps.js"

const error = (
  operation: UsageStoreError["operation"],
  reason: UsageStoreError["reason"],
  message: string,
  cause?: unknown
) =>
  new UsageStoreError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const storage = (operation: UsageStoreError["operation"], message: string) => (cause: unknown) =>
  cause instanceof UsageStoreError ? cause : error(operation, "storage", message, cause)

interface CountRow {
  readonly rows: number
}

interface DailyRow {
  readonly day: string
  readonly space_id: string
  readonly space_name: string | null
  readonly origin: UsageDailyCell["origin"]
  readonly session_type: NonNullable<UsageDailyCell["session_type"]> | ""
  readonly model_id: string
  readonly kind: UsageDailyCell["kind"]
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly runs: number
}

interface TopSessionRow {
  readonly session_id: string
  readonly name: string | null
  readonly space_id: string | null
  readonly space_name: string | null
  readonly session_type: NonNullable<UsageDailyCell["session_type"]>
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly runs: number
  readonly average_last_input: number | null
}

interface SessionRunRow {
  readonly run_id: string
  readonly turn_id: string
  readonly turn_index: number | null
  readonly status: SessionRunUsage["status"]
  readonly started_at: string
  readonly ended_at: string | null
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly duration_ms: number | null
  readonly tool_time_ms: number | null
  readonly steps: number | null
}

interface ModelCallRow {
  readonly run_id: string
  readonly prompt: number | null
  readonly completion: number | null
  readonly cache_read: number | null
  readonly cache_write: number | null
  readonly total: number | null
  readonly admitted_at: string | null
  readonly responded_at: string | null
}

const callUsage = (row: ModelCallRow): RunUsage | null =>
  row.prompt === null ||
  row.completion === null ||
  row.cache_read === null ||
  row.cache_write === null ||
  row.total === null
    ? null
    : {
        prompt: row.prompt,
        completion: row.completion,
        cache_read: row.cache_read,
        cache_write: row.cache_write,
        total: row.total
      }

const utcDay = (now: DateTime.Utc, back: number): string =>
  utcDayOf(DateTime.toEpochMillis(DateTime.subtract(now, { days: back })))

export const makeUsageStore = Effect.fn("SqliteUsageStore.make")(function* ({
  writer
}: Pick<PersistenceDeps, "writer">) {
  const sql = writer.sql
  const counted = yield* sql<CountRow>`
    SELECT count(*) AS rows FROM usage_daily
  `.pipe(Effect.mapError(storage("backfill", "Could not inspect the usage rollup")))
  if (counted[0]?.rows === 0) {
    yield* writer
      .run(
        sql`
      INSERT INTO usage_daily (
        day, space_id, origin, session_type, model_id, kind,
        total_tokens, output_tokens, cache_read_tokens, cache_write_tokens, runs
      )
      SELECT
        date(r.started_at),
        coalesce(s.space_id, ''),
        CASE
          WHEN s.origin_automation_id IS NOT NULL
            OR json_extract(r.metadata_json, '$.automation') IS NOT NULL
          THEN 'automation'
          ELSE 'user'
        END,
        s.session_type,
        coalesce(r.model_id, ''),
        'chat',
        sum(json_extract(r.metadata_json, '$.accounted_usage.total')),
        sum(json_extract(r.metadata_json, '$.accounted_usage.completion')),
        sum(json_extract(r.metadata_json, '$.accounted_usage.cache_read')),
        sum(json_extract(r.metadata_json, '$.accounted_usage.cache_write')),
        count(*)
      FROM chat_runs r
      JOIN sessions s ON s.session_id = r.session_id
      WHERE json_extract(r.metadata_json, '$.accounted_usage') IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5, 6
    `
      )
      .pipe(Effect.mapError(storage("backfill", "Could not backfill the usage rollup")))
  }

  const report = Effect.fn("SqliteUsageStore.report")(function* (options: {
    readonly days: number
    readonly throughDay?: string
  }) {
    if (!Number.isInteger(options.days) || options.days < 1 || options.days > 365) {
      return yield* error("report", "invalid", "The usage window must be 1 to 365 days")
    }
    const now = yield* DateTime.now
    const throughDay = options.throughDay ?? utcDay(now, 0)
    const end = Option.getOrUndefined(DateTime.make(`${throughDay}T00:00:00.000Z`))
    if (end === undefined || utcDayOf(DateTime.toEpochMillis(end)) !== throughDay) {
      return yield* error("report", "invalid", "throughDay must be a valid UTC calendar date")
    }
    const since = utcDay(end, options.days - 1)
    const until = utcDay(end, -1)
    const untilIso = `${until}T00:00:00.000Z`
    const sinceIso = `${since}T00:00:00.000Z`

    const daily = yield* sql<DailyRow>`
      SELECT
        u.day,
        u.space_id,
        d.name AS space_name,
        u.origin,
        u.session_type,
        u.model_id,
        u.kind,
        u.total_tokens AS total,
        u.output_tokens AS output,
        u.cache_read_tokens AS cache_read,
        u.cache_write_tokens AS cache_write,
        u.runs
      FROM usage_daily u
      LEFT JOIN spaces d ON d.space_id = u.space_id
      WHERE u.day >= ${since} AND u.day < ${until}
      ORDER BY u.day ASC, u.total_tokens DESC
    `.pipe(Effect.mapError(storage("report", "Could not read the usage rollup")))

    const topSessions = yield* sql<TopSessionRow>`
      SELECT
        s.session_id,
        s.name,
        d.space_id,
        d.name AS space_name,
        s.session_type,
        sum(json_extract(r.metadata_json, '$.accounted_usage.total')) AS total,
        sum(json_extract(r.metadata_json, '$.accounted_usage.completion')) AS output,
        sum(json_extract(r.metadata_json, '$.accounted_usage.cache_read')) AS cache_read,
        sum(json_extract(r.metadata_json, '$.accounted_usage.cache_write')) AS cache_write,
        count(*) AS runs,
        cast(avg(json_extract(r.metadata_json, '$.terminal_result.last_input_tokens')) AS INTEGER)
          AS average_last_input
      FROM chat_runs r
      JOIN sessions s ON s.session_id = r.session_id
      LEFT JOIN spaces d ON d.space_id = s.space_id
      WHERE r.started_at >= ${sinceIso} AND r.started_at < ${untilIso}
        AND json_extract(r.metadata_json, '$.accounted_usage') IS NOT NULL
      GROUP BY s.session_id
      ORDER BY total DESC
      LIMIT 12
    `.pipe(Effect.mapError(storage("report", "Could not read per-session usage")))

    const automations = yield* backgroundUsage(sql, sinceIso, untilIso).pipe(
      Effect.mapError(storage("report", "Could not read background-work usage"))
    )

    return {
      days: options.days,
      since,
      daily: daily.map((row) => ({
        day: row.day,
        space_id: row.space_id === "" ? null : row.space_id,
        space_name: row.space_name,
        origin: row.origin,
        session_type: row.session_type === "" ? null : row.session_type,
        model_id: row.model_id === "" ? null : row.model_id,
        kind: row.kind,
        total: row.total,
        output: row.output,
        cache_read: row.cache_read,
        cache_write: row.cache_write,
        runs: row.runs
      })),
      top_sessions: topSessions.map((row) => ({
        session_id: row.session_id,
        name: row.name,
        space_id: row.space_id,
        space_name: row.space_name,
        session_type: row.session_type,
        total: row.total,
        output: row.output,
        cache_read: row.cache_read,
        cache_write: row.cache_write,
        runs: row.runs,
        average_last_input: row.average_last_input
      })),
      automations
    } satisfies UsageReport
  })

  const sessionUsage = Effect.fn("SqliteUsageStore.sessionUsage")(function* (options: {
    readonly sessionId: string
    readonly limit: number
  }) {
    const runs = yield* sql<SessionRunRow>`
      SELECT
        r.run_id,
        json_extract(r.metadata_json, '$.turn_id') AS turn_id,
        t.turn_index,
        r.status,
        r.started_at,
        r.ended_at,
        r.model_id,
        r.reasoning_effort,
        json_extract(r.metadata_json, '$.terminal_result.duration_ms') AS duration_ms,
        json_extract(r.metadata_json, '$.terminal_result.tool_time_ms') AS tool_time_ms,
        json_extract(r.metadata_json, '$.terminal_result.steps') AS steps
      FROM chat_runs r
      LEFT JOIN session_turns t
        ON t.session_id = r.session_id AND t.turn_id = json_extract(r.metadata_json, '$.turn_id')
      WHERE r.session_id = ${options.sessionId}
        AND json_extract(r.metadata_json, '$.turn_id') IS NOT NULL
      ORDER BY r.started_at DESC, r.run_id DESC
      LIMIT ${options.limit}
    `.pipe(Effect.mapError(storage("session", "Could not read the chat's Runs")))
    const calls =
      runs.length === 0
        ? []
        : yield* sql<ModelCallRow>`
      SELECT
        run_id,
        json_extract(usage_json, '$.prompt') AS prompt,
        json_extract(usage_json, '$.completion') AS completion,
        json_extract(usage_json, '$.cache_read') AS cache_read,
        json_extract(usage_json, '$.cache_write') AS cache_write,
        json_extract(usage_json, '$.total') AS total,
        admitted_at,
        responded_at
      FROM run_model_usage
      WHERE run_id IN ${sql.in(runs.map((run) => run.run_id))}
      ORDER BY rowid
    `.pipe(Effect.mapError(storage("session", "Could not read the Runs' model calls")))
    const callsByRun = Map.groupBy(calls, (call) => call.run_id)
    return {
      session_id: options.sessionId,
      runs: runs.map((run) => ({
        run_id: run.run_id,
        turn_id: run.turn_id,
        turn_index: run.turn_index,
        status: run.status,
        started_at: run.started_at,
        ended_at: run.ended_at,
        model_id: run.model_id,
        reasoning_effort: run.reasoning_effort,
        timing:
          run.duration_ms === null || run.tool_time_ms === null || run.steps === null
            ? null
            : { duration_ms: run.duration_ms, tool_time_ms: run.tool_time_ms, steps: run.steps },
        calls: (callsByRun.get(run.run_id) ?? []).map((call) => ({
          usage: callUsage(call),
          admitted_at: call.admitted_at,
          responded_at: call.responded_at
        }))
      }))
    } satisfies StoredSessionUsage
  })

  const recordModelCall: UsageStore["Service"]["recordModelCall"] = Effect.fn(
    "SqliteUsageStore.recordModelCall"
  )(function* (input) {
    const day = utcDay(yield* DateTime.now, 0)
    const sessionId = input.owner.type === "session" ? input.owner.sessionId : null
    const spaceId = input.owner.type === "space" ? input.owner.spaceId : ""
    const { usage } = input
    yield* writer
      .run(
        sql`
      INSERT INTO usage_daily (
        day, space_id, origin, session_type, model_id, kind,
        total_tokens, output_tokens, cache_read_tokens, cache_write_tokens, runs
      )
      SELECT ${day}, coalesce(s.space_id, ${spaceId}),
        CASE WHEN s.origin_automation_id IS NOT NULL THEN 'automation' ELSE 'user' END,
        coalesce(s.session_type, ''), ${input.modelId}, ${input.kind},
        ${usage.total}, ${usage.completion}, ${usage.cache_read}, ${usage.cache_write}, 1
      FROM (SELECT 1) AS call LEFT JOIN sessions s ON s.session_id = ${sessionId}
      WHERE true
      ON CONFLICT (day, space_id, origin, session_type, model_id, kind) DO UPDATE SET
        total_tokens = total_tokens + excluded.total_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        runs = runs + excluded.runs
    `
      )
      .pipe(Effect.mapError(storage("record", "Could not record model-call usage")))
  })

  return UsageStore.of({ report, sessionUsage, recordModelCall })
})
