import { journalHeadSequenceSql, journalRecordsSql } from "@arden-hq/journal/effect"
import { Effect, Schema } from "effect"
import { lifecycleError } from "./lifecycle-archived.js"
import { SqlClient } from "effect/unstable/sql"
import { SESSION_LIFECYCLE_STREAM_ID, SessionLifecycleEventError } from "../sessions/events.js"
import type { PersistenceDeps } from "./deps.js"
import { deleteJournalSequences, scanJournalWindows } from "./journal-windows.js"

const SNAPSHOT_DELETE_BATCH = 500

const SNAPSHOT_EVENT_TYPES = "('session_created', 'session_activity')"

const snapshotSessionOf = (sql: SqlClient.SqlClient, table: string) =>
  sql.literal(`json_extract(${table}.data_json, '$.session.session_id')`)

interface SessionHistoryBoundary {
  readonly sessionId: string
  readonly retainedSequence: number
}

interface SnapshotScanRow {
  readonly sequence: number
  readonly session_id: string | null
}

const foldSnapshotPage = (
  latest: Map<string, number>,
  superseded: Array<number>,
  page: ReadonlyArray<SnapshotScanRow>,
  readThrough: number
): void => {
  for (const row of page) {
    if (row.session_id === null) continue
    const previous = latest.get(row.session_id)
    if (previous !== undefined && previous <= readThrough) superseded.push(previous)
    latest.set(row.session_id, row.sequence)
  }
}

export interface SessionPruning {
  readonly pruneSessionHistory: (
    entries: ReadonlyArray<SessionHistoryBoundary>
  ) => Effect.Effect<number, SessionLifecycleEventError>
  readonly pruneSupersededSnapshots: () => Effect.Effect<number, SessionLifecycleEventError>
}

export const makeSessionPruning = (writer: PersistenceDeps["writer"]): SessionPruning => {
  const sql = writer.sql
  const pruneSessionHistory = Effect.fn("SessionLifecycleEvents.pruneSessionHistory")(
    function* (entries: ReadonlyArray<SessionHistoryBoundary>) {
      const valid = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            sessionId: Schema.NonEmptyString,
            retainedSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
          })
        )
      )(entries).pipe(
        Effect.mapError((cause) =>
          lifecycleError("prune", "Invalid Session lifecycle retention boundary", cause)
        )
      )
      if (valid.length === 0) return 0
      const boundary = new Map<string, number>()
      for (const entry of valid) boundary.set(entry.sessionId, entry.retainedSequence)
      const bounds = yield* writer.run(
        sql<{ readonly first: number | null; readonly head: number | null }>`
          SELECT
            (SELECT MIN(sequence) FROM ${journalRecordsSql(sql)}
             WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}) AS first,
            ${journalHeadSequenceSql(sql, SESSION_LIFECYCLE_STREAM_ID)} AS head
        `
      )
      const first = bounds[0]?.first ?? null
      const head = bounds[0]?.head ?? null
      if (first === null || head === null) return 0
      const types = sql.literal(SNAPSHOT_EVENT_TYPES)
      const sequences = new Map<string, Array<number>>()
      yield* scanJournalWindows<SnapshotScanRow, never>({
        sql,
        read: writer.run,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        afterSequence: first - 1,
        throughSequence: head,
        columns: sql`sequence, ${snapshotSessionOf(sql, "journal_records")} AS session_id`,
        where: sql`event_type IN ${types}
          AND ${snapshotSessionOf(sql, "journal_records")} IN ${sql.in([...boundary.keys()])}`,
        onPage: (page) =>
          Effect.sync(() => {
            for (const row of page) {
              if (row.session_id === null) continue
              const list = sequences.get(row.session_id)
              if (list === undefined) sequences.set(row.session_id, [row.sequence])
              else list.push(row.sequence)
            }
          })
      })
      const doomed: Array<number> = []
      for (const [sessionId, list] of sequences) {
        const newest = list[list.length - 1]
        const retained = boundary.get(sessionId)
        if (newest === undefined || retained === undefined) continue
        const below = Math.min(newest, retained)
        for (const sequence of list) if (sequence < below) doomed.push(sequence)
      }
      return yield* deleteJournalSequences({
        writer,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        beforeSequence: head + 1,
        sequences: doomed,
        batchSize: SNAPSHOT_DELETE_BATCH,
        where: sql`event_type IN ${types}`
      })
    },
    Effect.mapError((cause) =>
      cause instanceof SessionLifecycleEventError
        ? cause
        : lifecycleError("prune", "Could not prune prior Session lifecycle snapshots", cause)
    )
  )

  const pruneSupersededSnapshots = Effect.fn("SessionLifecycleEvents.pruneSupersededSnapshots")(
    function* () {
      const cursor = yield* writer.run(
        sql<{ readonly after_sequence: number }>`
          SELECT after_sequence FROM automation_trigger_cursor
          WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
        `
      )
      const readThrough = cursor[0]?.after_sequence
      if (readThrough === undefined) return 0
      const types = sql.literal(SNAPSHOT_EVENT_TYPES)
      const latest = new Map<string, number>()
      const superseded: Array<number> = []
      const bounds = yield* writer.run(
        sql<{ readonly first: number | null; readonly head: number | null }>`
          SELECT
            (SELECT MIN(sequence) FROM ${journalRecordsSql(sql)}
             WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}) AS first,
            ${journalHeadSequenceSql(sql, SESSION_LIFECYCLE_STREAM_ID)} AS head
        `
      )
      const first = bounds[0]?.first ?? null
      const head = bounds[0]?.head ?? null
      if (first === null || head === null) return 0
      yield* scanJournalWindows<SnapshotScanRow, never>({
        sql,
        read: writer.run,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        afterSequence: first - 1,
        throughSequence: head,
        columns: sql`sequence, ${snapshotSessionOf(sql, "journal_records")} AS session_id`,
        where: sql`event_type IN ${types}`,
        onPage: (page) => Effect.sync(() => foldSnapshotPage(latest, superseded, page, readThrough))
      })
      return yield* deleteJournalSequences({
        writer,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        beforeSequence: readThrough + 1,
        sequences: superseded,
        batchSize: SNAPSHOT_DELETE_BATCH,
        where: sql`event_type IN ${types}`
      })
    },
    Effect.mapError((cause) =>
      cause instanceof SessionLifecycleEventError
        ? cause
        : lifecycleError("prune", "Could not prune superseded Session snapshots", cause)
    )
  )
  return { pruneSessionHistory, pruneSupersededSnapshots }
}
