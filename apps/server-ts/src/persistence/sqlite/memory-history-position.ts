import { DateTime, Effect, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { UnitOfWork } from "../unit-of-work.js"

const READERS = {
  publication: { namespace: "wiki_publication", field: "revision" },
  maintenance: { namespace: "wiki_maintenance", field: "processedHead" }
} as const

export type MemoryHistoryReader = keyof typeof READERS

export class MemoryHistoryPositionError extends Schema.TaggedError<MemoryHistoryPositionError>()(
  "MemoryHistoryPositionError",
  {
    reason: Schema.Literals(["missing", "corrupt", "invalid"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

/** "already_there" when the place is at `next`; "moved" when another writer moved it first. */
export type PositionAdvance = "advanced" | "already_there" | "moved"

const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const Move = Schema.Struct({ expected: Schema.NullOr(Revision), next: Revision })
const State = Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Revision)))

type PositionError = MemoryHistoryPositionError | SqlError.SqlError

export const memoryHistoryPosition = (reader: MemoryHistoryReader) => {
  const { namespace, field } = READERS[reader]
  const encode = (revision: string | null): string => JSON.stringify({ [field]: revision })

  const readRow = Effect.fn("MemoryHistoryPosition.readRow")(function* (
    sql: SqlClient.SqlClient
  ): Effect.fn.Return<{ readonly raw: string; readonly revision: string | null }, PositionError> {
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM monitor_state WHERE namespace = ${namespace} LIMIT 1`
    const raw = rows[0]?.state
    if (raw === undefined) {
      return yield* new MemoryHistoryPositionError({
        reason: "missing",
        message: `The ${reader} place in Memory history is not set`
      })
    }
    const state = yield* Schema.decodeUnknownEffect(State)(raw).pipe(
      Effect.mapError(
        (cause) =>
          new MemoryHistoryPositionError({
            reason: "corrupt",
            message: `The ${reader} place in Memory history is corrupt`,
            cause
          })
      )
    )
    const revision = state[field]
    if (revision === undefined || Object.keys(state).length !== 1) {
      return yield* new MemoryHistoryPositionError({
        reason: "corrupt",
        message: `The ${reader} place in Memory history is corrupt`
      })
    }
    return { raw, revision }
  })

  const start = Effect.fn("MemoryHistoryPosition.start")(function* (
    sql: SqlClient.SqlClient,
    initial: string | null
  ): Effect.fn.Return<string | null, PositionError> {
    const now = DateTime.formatIso(yield* DateTime.now)
    yield* sql`
        INSERT INTO monitor_state (namespace, state, updated_at)
        VALUES (${namespace}, ${encode(initial)}, ${now})
        ON CONFLICT(namespace) DO NOTHING`
    return (yield* readRow(sql)).revision
  })

  const read = (sql: SqlClient.SqlClient): Effect.Effect<string | null, PositionError> =>
    readRow(sql).pipe(Effect.map((row) => row.revision))

  const advance = Effect.fn("MemoryHistoryPosition.advance")(function* (
    sql: SqlClient.SqlClient,
    input: { readonly expected: string | null; readonly next: string }
  ): Effect.fn.Return<PositionAdvance, PositionError, UnitOfWork> {
    yield* Schema.decodeUnknownEffect(Move)(input).pipe(
      Effect.mapError(
        (cause) =>
          new MemoryHistoryPositionError({
            reason: "invalid",
            message: `The ${reader} place can move only between Memory commits`,
            cause
          })
      )
    )
    const current = yield* readRow(sql)
    if (current.revision === input.next) return "already_there"
    if (current.revision !== input.expected) return "moved"
    const now = DateTime.formatIso(yield* DateTime.now)
    const moved = yield* sql<{ readonly namespace: string }>`
        UPDATE monitor_state SET state = ${encode(input.next)}, updated_at = ${now}
        WHERE namespace = ${namespace} AND state = ${current.raw}
        RETURNING namespace`
    return moved.length === 0 ? "moved" : "advanced"
  })

  return { start, read, advance }
}
