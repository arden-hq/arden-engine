import { RETENTION } from "@arden-hq/protocol/storage"
import { journalRecordsSql, retainFromInTransaction } from "@arden-hq/journal/effect"
import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { StoragePolicyStore } from "../storage/store.js"
import { SESSION_LIFECYCLE_STREAM_ID } from "../sessions/events.js"
import type { PersistenceDeps } from "./deps.js"
import { journalRunIdSql, RUN_BOUNDARY_TYPES } from "./journal-run-boundary.js"
import { batchPause, walkJournal, type WalkDecision, type WalkRow } from "./journal-walk.js"
import { deleteJournalSequences, scanJournalWindows } from "./journal-windows.js"
import { activeRunStatusList } from "./status-sets.js"

const RELEASE_BATCH_ROWS = 2_000

const LIFECYCLE_STATUS_TYPES = new Set([
  "automation_progress",
  "automation_finished",
  "automation_queued"
])
const LIFECYCLE_STATUS_DAYS = 7

type Writer = PersistenceDeps["writer"]

const daysAgo = Effect.fn("JournalRetention.daysAgo")(function* (days: number) {
  return DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days }))
})

const nothingAfter = () => Effect.void

const trimLifecycleStatusRows = Effect.fn("JournalRetention.trimLifecycleStatusRows")(function* (
  writer: Writer
) {
  const read = (yield* writer.reader<{ readonly after_sequence: number }>`
    SELECT after_sequence FROM automation_trigger_cursor
    WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
  `)[0]?.after_sequence
  if (read === undefined) return 0
  return yield* walkJournal({
    writer,
    name: "lifecycle_status",
    cutoff: yield* daysAgo(LIFECYCLE_STATUS_DAYS),
    stop: (row) => row.stream_id === SESSION_LIFECYCLE_STREAM_ID && row.sequence > read,
    decide: Effect.fn("JournalRetention.decideLifecycleRows")(function* (sql, rows) {
      const matching = rows.filter(
        (row) =>
          row.stream_id === SESSION_LIFECYCLE_STREAM_ID &&
          LIFECYCLE_STATUS_TYPES.has(row.event_type)
      )
      if (matching.length === 0) return { remove: [], after: nothingAfter } satisfies WalkDecision
      const head = (yield* sql<{ readonly head_sequence: number }>`
        SELECT head_sequence FROM journal_streams WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
      `)[0]?.head_sequence
      return {
        remove: matching.filter((row) => row.sequence !== head),
        after: nothingAfter
      } satisfies WalkDecision
    })
  })
})

const pinnedRunSql = (sql: SqlClient.SqlClient, cutoff: string, alias: string) => {
  const run = sql.literal(alias)
  return sql`(${run}.status IN ${activeRunStatusList} OR ${run}.ended_at > ${cutoff}
    OR EXISTS (SELECT 1 FROM code_mode_scripts AS script
      WHERE script.origin_run_id = ${run}.run_id AND script.progress_json IS NULL))`
}

const freeRunSql = (sql: SqlClient.SqlClient, cutoff: string, run: string) =>
  sql`(NOT ${pinnedRunSql(sql, cutoff, run)})`

const markTraceRemoved = Effect.fn("JournalRetention.markTraceRemoved")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly runs: ReadonlyArray<string>; readonly streams: ReadonlyArray<string> }
) {
  if (input.runs.length > 0) {
    const removedAt = DateTime.formatIso(yield* DateTime.now)
    yield* sql`
      UPDATE chat_runs
      SET last_seq = NULL,
          metadata_json = json_set(metadata_json, '$.trace_removed_at',
            COALESCE(json_extract(metadata_json, '$.trace_removed_at'), ${removedAt}))
      WHERE run_id IN ${sql.in(input.runs)}
    `
  }
  for (const streamId of input.streams) {
    const first = (yield* sql<{ readonly sequence: number | null }>`
      SELECT MIN(sequence) AS sequence FROM ${journalRecordsSql(sql)} WHERE stream_id = ${streamId}
    `)[0]?.sequence
    if (first !== undefined && first !== null && first > 1)
      yield* retainFromInTransaction(sql, { streamId, fromSequence: first })
  }
})

interface Held {
  streamId: string
  from: number
  through: number
}

const decideSessionRows = Effect.fn("JournalRetention.decideSessionRows")(function* (
  sql: SqlClient.SqlClient,
  cutoff: string,
  rows: ReadonlyArray<WalkRow>
) {
  const boundary = new Set(RUN_BOUNDARY_TYPES)
  const candidates = rows.filter((row) => row.run_id === null || !boundary.has(row.event_type))
  if (candidates.length === 0) return { remove: [], after: nothingAfter } satisfies WalkDecision
  const streams = [...new Set(candidates.map((row) => row.stream_id))]
  const sessions = new Set(
    (yield* sql<{ readonly session_id: string }>`
      SELECT session_id FROM sessions WHERE session_id IN ${sql.in(streams)}
    `).map((row) => row.session_id)
  )
  const checkpoints = new Map(
    (yield* sql<{ readonly session_id: string; readonly checkpoint_seq: number }>`
      SELECT session_id, checkpoint_seq FROM session_event_checkpoints
      WHERE session_id IN ${sql.in(streams)}
    `).map((row) => [row.session_id, row.checkpoint_seq])
  )
  const heads = new Map(
    (yield* sql<{ readonly stream_id: string; readonly head_sequence: number }>`
      SELECT stream_id, head_sequence FROM journal_streams WHERE stream_id IN ${sql.in(streams)}
    `).map((row) => [row.stream_id, row.head_sequence])
  )
  const runIds = [...new Set(candidates.flatMap((row) => row.run_id ?? []))]
  const runs = new Map(
    (runIds.length === 0
      ? []
      : yield* sql<{ readonly run_id: string; readonly session_id: string; readonly free: number }>`
          SELECT run.run_id, run.session_id, ${freeRunSql(sql, cutoff, "run")} AS free
          FROM chat_runs AS run WHERE run.run_id IN ${sql.in(runIds)}
        `
    ).map((row) => [row.run_id, row])
  )
  const remove: Array<WalkRow> = []
  const held = new Map<string, Held>()
  for (const row of candidates) {
    if (
      !sessions.has(row.stream_id) ||
      row.sequence === heads.get(row.stream_id) ||
      row.sequence > (checkpoints.get(row.stream_id) ?? 0)
    )
      continue
    if (row.run_id === null) {
      remove.push(row)
      continue
    }
    const run = runs.get(row.run_id)
    if (run !== undefined && run.session_id !== row.stream_id) continue
    if (run === undefined || run.free === 1) {
      remove.push(row)
      continue
    }
    const before = held.get(row.run_id)
    held.set(row.run_id, {
      streamId: row.stream_id,
      from: Math.min(before?.from ?? row.sequence, row.sequence),
      through: Math.max(before?.through ?? row.sequence, row.sequence)
    })
  }
  return {
    remove,
    after: Effect.fn("JournalRetention.afterSessionRows")(function* (removed) {
      yield* markTraceRemoved(sql, {
        runs: [...new Set(removed.flatMap((row) => row.run_id ?? []))],
        streams: [...new Set(removed.map((row) => row.stream_id))]
      })
      for (const [runId, hold] of held)
        yield* sql`
          INSERT INTO journal_retention_held (run_id, stream_id, from_sequence, through_sequence)
          VALUES (${runId}, ${hold.streamId}, ${hold.from}, ${hold.through})
          ON CONFLICT(run_id) DO UPDATE SET
            from_sequence = MIN(journal_retention_held.from_sequence, excluded.from_sequence),
            through_sequence = MAX(journal_retention_held.through_sequence, excluded.through_sequence)
        `
    })
  } satisfies WalkDecision
})

interface HeldRow {
  readonly run_id: string
  readonly stream_id: string
  readonly from_sequence: number
  readonly through_sequence: number
  readonly missing: number
}

const releaseHeldRun = Effect.fn("JournalRetention.releaseHeldRun")(function* (
  writer: Writer,
  cutoff: string,
  held: HeldRow
) {
  const { sql, reader } = writer
  const drop = sql`DELETE FROM journal_retention_held WHERE run_id = ${held.run_id}`
  if (held.missing === 1) {
    yield* writer.transact(drop)
    return 0
  }
  const head = (yield* reader<{ readonly head_sequence: number }>`
    SELECT head_sequence FROM journal_streams WHERE stream_id = ${held.stream_id}
  `)[0]?.head_sequence
  if (head === undefined) return 0
  const mine = sql`${journalRunIdSql(sql)} = ${held.run_id}
    AND event_type NOT IN ${sql.in(RUN_BOUNDARY_TYPES)}`
  const sequences: Array<number> = []
  yield* scanJournalWindows<{ readonly sequence: number }, never>({
    sql: reader,
    streamId: held.stream_id,
    afterSequence: held.from_sequence - 1,
    throughSequence: Math.min(held.through_sequence, head - 1),
    columns: sql`sequence`,
    where: mine,
    onPage: (page) => Effect.sync(() => void sequences.push(...page.map((row) => row.sequence)))
  })
  const deleted = yield* deleteJournalSequences({
    writer,
    streamId: held.stream_id,
    beforeSequence: head,
    sequences,
    batchSize: RELEASE_BATCH_ROWS,
    where: sql`${mine} AND EXISTS (
      SELECT 1 FROM chat_runs AS run
      WHERE run.run_id = ${held.run_id} AND ${freeRunSql(sql, cutoff, "run")})`,
    pause: batchPause(reader)
  })
  if (deleted === sequences.length)
    yield* writer.transact(
      Effect.gen(function* () {
        yield* markTraceRemoved(sql, {
          runs: deleted > 0 ? [held.run_id] : [],
          streams: deleted > 0 ? [held.stream_id] : []
        })
        yield* drop
      })
    )
  return deleted
})

const trimSessionJournals = Effect.fn("JournalRetention.trimSessionJournals")(function* (
  writer: Writer,
  agentTraceDays: number
) {
  const { sql, reader } = writer
  const cutoff = yield* daysAgo(agentTraceDays)
  let deleted = yield* walkJournal({
    writer,
    name: "session_steps",
    cutoff,
    decide: (sql, rows) => decideSessionRows(sql, cutoff, rows)
  })
  const releasable = yield* reader<HeldRow>`
    SELECT held.run_id, held.stream_id, held.from_sequence, held.through_sequence,
      run.run_id IS NULL AS missing
    FROM journal_retention_held AS held
    LEFT JOIN chat_runs AS run ON run.run_id = held.run_id
    WHERE run.run_id IS NULL
      OR (run.session_id = held.stream_id AND ${freeRunSql(sql, cutoff, "run")})
  `
  for (const row of releasable)
    deleted += yield* releaseHeldRun(writer, cutoff, row).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not release a held run's journal rows", {
          runId: row.run_id,
          cause
        }).pipe(Effect.as(0))
      )
    )
  return deleted
})

export const trimJournals = Effect.fn("JournalRetention.trimJournals")(function* ({
  writer,
  policy
}: Pick<PersistenceDeps, "writer"> & {
  readonly policy: Pick<StoragePolicyStore["Service"], "retention">
}) {
  const lifecycle = yield* trimLifecycleStatusRows(writer).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Lifecycle journal retention failed", cause).pipe(Effect.as(0))
    )
  )
  const sessions = yield* policy.retention().pipe(
    Effect.flatMap((retention) =>
      retention.agentTrace.kind === RETENTION.days
        ? trimSessionJournals(writer, retention.agentTrace.days)
        : Effect.succeed(0)
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Session journal retention failed", cause).pipe(Effect.as(0))
    )
  )
  if (lifecycle + sessions > 0)
    yield* Effect.logInfo("Trimmed old journal records", { lifecycle, sessions })
  return { lifecycle, sessions }
})
