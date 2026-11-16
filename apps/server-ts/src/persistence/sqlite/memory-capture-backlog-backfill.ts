import { DateTime, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { capturedText } from "../transcript/content.js"
import { StoredMessageEnvelopeSchema } from "../transcript/model.js"
import type { Backfill } from "./backfills/backfill.js"

const MARKS = "json_type(evidence_json, '$.memory_capture') IS NOT NULL"

/** A `message` the owner typed: the user message that opens a turn, not a note the app added. */
export const TYPED_TURN = `message.role = 'user'
  AND json_extract(message.message_json, '$.is_meta') IS NULL
  AND EXISTS (SELECT 1 FROM session_turns AS turn
    WHERE turn.session_id = message.session_id AND turn.user_message_id = message.message_id)`

/** The old batch shape: its end is a bare sequence and offset. The current shape tags its end. */
const OLD_BATCH = "json_type(run.metadata_json, '$.memory_capture_batch.end.offset') = 'integer'"

/** The header the old Capture wrote before each message it quoted in its prompt. */
const EXCERPT = /\[(?:user|assistant); sequence (\d+); characters \d+-\d+; /gu

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(StoredMessageEnvelopeSchema))

interface BatchRow {
  readonly session_id: string
  readonly started_at: string
  readonly start_tag: string
  readonly start_seq: number | null
  readonly end_seq: number
  readonly end_offset: number
  readonly ending: string | null
  readonly prompt: string
}

interface ReadBatch {
  readonly sessionId: string
  readonly startedAt: string
  readonly from: number
  readonly through: number
  readonly quoted: ReadonlySet<number>
}

interface RangedMessage {
  readonly seq: number
  readonly role: string
  readonly created_at: string
  readonly typed: number
  readonly copy: number
}

interface Range {
  readonly from: number
  readonly through: number
}

export const memoryCaptureBacklogBackfill: Backfill = {
  name: "memory_capture_backlog",
  chunk: Effect.fn("MemoryCaptureBacklog.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const sessions = yield* sql<{ readonly session_id: string; readonly ranged: number }>`
      SELECT session_id,
             EXISTS (SELECT 1 FROM memory_capture_unread AS unread
               WHERE unread.session_id = session.session_id AND unread.through_seq IS NOT NULL)
               AS ranged
      FROM sessions AS session
      WHERE session_id > ${cursor ?? ""}
      ORDER BY session_id LIMIT ${limit}`
    const ranged = sessions.filter((session) => session.ranged === 1).map((s) => s.session_id)
    const batches = ranged.length === 0 ? [] : yield* readBatches(sql, ranged)
    const now = DateTime.formatIso(yield* DateTime.now)
    let converted = 0
    for (const { session_id: sessionId } of sessions) {
      const messages = yield* sql<RangedMessage>`
        SELECT message.seq, message.role, message.created_at,
               ${sql.literal(TYPED_TURN)} AS typed,
               EXISTS (SELECT 1 FROM session_messages AS source
                 WHERE source.session_id = json_extract(session.metadata,
                     '$.fork_origin.sourceSessionId')
                   AND source.message_id = message.message_id) AS copy
        FROM session_messages AS message
        JOIN sessions AS session ON session.session_id = message.session_id
        JOIN memory_capture_unread AS unread ON unread.session_id = message.session_id
          AND message.seq BETWEEN unread.read_seq + (unread.read_offset IS NULL)
            AND unread.through_seq
        WHERE message.session_id = ${sessionId}
        ORDER BY message.seq`
      const ranges = unreadRanges(
        messages,
        batches.filter((batch) => batch.sessionId === sessionId)
      )
      yield* sql`DELETE FROM memory_capture_unread
        WHERE session_id = ${sessionId} AND through_seq IS NOT NULL`
      for (const range of ranges)
        yield* sql`INSERT INTO memory_capture_unread (session_id, read_seq, through_seq, updated_at)
          VALUES (${sessionId}, ${range.from - 1}, ${range.through}, ${now})`
      const deleted = yield* sql`DELETE FROM run_sidecars
        WHERE session_id = ${sessionId} AND ${sql.literal(MARKS)}
          AND json_remove(evidence_json, '$.memory_capture') = '{}'
          AND context_manifest_json = '[]' AND source_refs_json = '[]'
        RETURNING run_id`
      const removed = yield* sql`UPDATE run_sidecars
        SET evidence_json = json_remove(evidence_json, '$.memory_capture')
        WHERE session_id = ${sessionId} AND ${sql.literal(MARKS)}
        RETURNING run_id`
      converted += deleted.length + removed.length
    }
    const last = sessions.at(-1)
    return { converted, next: last === undefined ? undefined : last.session_id }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(DISTINCT session_id) AS count FROM run_sidecars WHERE ${sql.literal(MARKS)}`
    return rows[0]?.count ?? 0
  })
}

/** What each finished old Capture run over one of `sessionIds` was shown. */
const readBatches = Effect.fn("MemoryCaptureBacklog.readBatches")(function* (
  sql: SqlClient.SqlClient,
  sessionIds: ReadonlyArray<string>
) {
  const rows = yield* sql<BatchRow>`
    SELECT json_extract(run.metadata_json, '$.memory_capture_batch.sessionId') AS session_id,
           run.started_at,
           json_extract(run.metadata_json, '$.memory_capture_batch.start._tag') AS start_tag,
           CAST(COALESCE(
             json_extract(run.metadata_json, '$.memory_capture_batch.start.sequence'),
             json_extract(run.metadata_json, '$.memory_capture_batch.start.progress.sequence'))
             AS INTEGER) AS start_seq,
           CAST(json_extract(run.metadata_json, '$.memory_capture_batch.end.sequence') AS INTEGER)
             AS end_seq,
           CAST(json_extract(run.metadata_json, '$.memory_capture_batch.end.offset') AS INTEGER)
             AS end_offset,
           ending.message_json AS ending,
           prompt.message_json AS prompt
    FROM chat_runs AS run
    JOIN session_turns AS turn ON turn.session_id = run.session_id
      AND turn.turn_id = json_extract(run.metadata_json, '$.turn_id')
    JOIN session_messages AS prompt ON prompt.session_id = turn.session_id
      AND prompt.message_id = turn.user_message_id
    LEFT JOIN session_messages AS ending
      ON ending.session_id = json_extract(run.metadata_json, '$.memory_capture_batch.sessionId')
      AND ending.seq = json_extract(run.metadata_json, '$.memory_capture_batch.end.sequence')
    WHERE run.status = 'completed' AND ${sql.literal(OLD_BATCH)}
      AND json_extract(run.metadata_json, '$.memory_capture_batch.sessionId')
        IN ${sql.in(sessionIds)}`
  return rows.flatMap((row): ReadonlyArray<ReadBatch> => {
    const quoted = Array.from(row.prompt.matchAll(EXCERPT), (match) => Number(match[1]))
    const from = batchStart(row, quoted)
    if (from === undefined) return []
    return [
      {
        sessionId: row.session_id,
        startedAt: row.started_at,
        from,
        through: endsWhole(row) ? row.end_seq : row.end_seq - 1,
        quoted: new Set(quoted)
      }
    ]
  })
})

/** The first message a batch was shown, or undefined when that is not known. */
const batchStart = (row: BatchRow, quoted: ReadonlyArray<number>): number | undefined => {
  switch (row.start_tag) {
    case "AfterSequence":
      return row.start_seq === null ? undefined : row.start_seq + 1
    case "AtPosition":
      return row.start_seq ?? undefined
    case "Beginning":
      return quoted[0]
    default:
      return undefined
  }
}

const endsWhole = (row: BatchRow): boolean => {
  if (row.ending === null) return true
  const ending = decodeMessage(row.ending)
  return Option.isSome(ending) && row.end_offset >= (capturedText(ending.value)?.length ?? 0)
}

const readBy = (message: RangedMessage, batch: ReadBatch): boolean =>
  message.seq >= batch.from &&
  message.seq <= batch.through &&
  message.created_at <= batch.startedAt &&
  (message.typed === 0 || batch.quoted.has(message.seq))

/**
 * Runs of unread user and assistant messages, broken by a read message or a copy. Capture reads
 * no other message, so another message joins a run around it but never starts or ends one.
 */
const unreadRanges = (
  messages: ReadonlyArray<RangedMessage>,
  batches: ReadonlyArray<ReadBatch>
): ReadonlyArray<Range> => {
  const ranges: Array<Range> = []
  let open: Range | undefined
  for (const message of messages) {
    if (message.copy === 1 || batches.some((batch) => readBy(message, batch))) {
      if (open !== undefined) ranges.push(open)
      open = undefined
      continue
    }
    if (message.role !== "user" && message.role !== "assistant") continue
    open =
      open === undefined
        ? { from: message.seq, through: message.seq }
        : { ...open, through: message.seq }
  }
  if (open !== undefined) ranges.push(open)
  return ranges
}
