import { DateTime, Effect, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import { DAILY_SUMMARY_AUTOMATION_ID } from "../automations/model.js"
import {
  ReaderPositionError,
  ReaderPositions,
  type PositionAdvance,
  type ReaderPosition
} from "../reader-position.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { automationPositionNamespace } from "./automation-resume.js"
import type { Writer } from "./deps.js"

const Commit = Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)))
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))

const READERS = {
  publication: {
    name: "Wiki publication",
    namespace: "wiki_publication",
    field: "revision",
    value: Commit
  },
  maintenance: {
    name: "Wiki Maintenance",
    namespace: "wiki_maintenance",
    field: "processedHead",
    value: Commit
  },
  dailySummary: {
    name: "Daily Summary",
    namespace: automationPositionNamespace(DAILY_SUMMARY_AUTOMATION_ID),
    field: "settledDay",
    value: Day
  }
} as const

type Reader = keyof typeof READERS
type PositionOf<R extends Reader> = (typeof READERS)[R]["value"]["Type"]
type PositionError = ReaderPositionError | SqlError.SqlError

/** One reader's position: a `monitor_state` row holding `{ [field]: position }`. */
export const readerPosition = <R extends Reader>(reader: R) => {
  const { name, namespace, field } = READERS[reader]
  const Position = READERS[reader].value as Schema.Codec<PositionOf<R>>
  const State = Schema.fromJsonString(Schema.Record(Schema.String, Position))
  const failure =
    (reason: ReaderPositionError["reason"], message: string) =>
    (cause?: unknown): ReaderPositionError =>
      new ReaderPositionError({
        reason,
        message: `The ${name} position ${message}`,
        ...(cause === undefined ? {} : { cause })
      })
  const valid = (position: PositionOf<R>) =>
    Schema.decodeUnknownEffect(Position)(position).pipe(
      Effect.mapError(failure("invalid", `cannot be ${String(position)}`))
    )

  const readRow = Effect.fn("ReaderPosition.readRow")(function* (
    sql: SqlClient.SqlClient
  ): Effect.fn.Return<{ readonly raw: string; readonly position: PositionOf<R> }, PositionError> {
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM monitor_state WHERE namespace = ${namespace} LIMIT 1`
    const raw = rows[0]?.state
    if (raw === undefined) return yield* failure("missing", "is not set")()
    const state = yield* Schema.decodeUnknownEffect(State)(raw).pipe(
      Effect.mapError(failure("corrupt", "is corrupt"))
    )
    const position = state[field]
    if (position === undefined || Object.keys(state).length !== 1)
      return yield* failure("corrupt", "is corrupt")()
    return { raw, position }
  })

  const start = Effect.fn("ReaderPosition.start")(function* (
    sql: SqlClient.SqlClient,
    initial: PositionOf<R>
  ): Effect.fn.Return<PositionOf<R>, PositionError, UnitOfWork> {
    yield* valid(initial)
    const now = DateTime.formatIso(yield* DateTime.now)
    yield* sql`
        INSERT INTO monitor_state (namespace, state, updated_at)
        VALUES (${namespace}, ${JSON.stringify({ [field]: initial })}, ${now})
        ON CONFLICT(namespace) DO NOTHING`
    return (yield* readRow(sql)).position
  })

  const read = (sql: SqlClient.SqlClient): Effect.Effect<PositionOf<R>, PositionError> =>
    readRow(sql).pipe(Effect.map((row) => row.position))

  const advance = Effect.fn("ReaderPosition.advance")(function* (
    sql: SqlClient.SqlClient,
    input: { readonly expected: PositionOf<R>; readonly next: PositionOf<R> }
  ): Effect.fn.Return<PositionAdvance, PositionError, UnitOfWork> {
    yield* valid(input.expected)
    yield* valid(input.next)
    const current = yield* readRow(sql)
    if (current.position === input.next) return "already_there"
    if (current.position !== input.expected) return "moved"
    const now = DateTime.formatIso(yield* DateTime.now)
    const moved = yield* sql<{ readonly namespace: string }>`
        UPDATE monitor_state SET state = ${JSON.stringify({ [field]: input.next })}, updated_at = ${now}
        WHERE namespace = ${namespace} AND state = ${current.raw}
        RETURNING namespace`
    return moved.length === 0 ? "moved" : "advanced"
  })

  const stored = (cause: unknown): ReaderPositionError =>
    cause instanceof ReaderPositionError ? cause : failure("storage", "could not be stored")(cause)

  const on = (writer: Writer): ReaderPosition<PositionOf<R>> => ({
    start: (initial) => writer.transact(start(writer.sql, initial)).pipe(Effect.mapError(stored)),
    read: () => read(writer.sql).pipe(Effect.mapError(stored)),
    advance: (input) =>
      writer
        .transact(
          advance(writer.sql, input).pipe(
            Effect.filterOrFail(
              (outcome) => outcome !== "moved",
              () => failure("moved", "moved before this advance")()
            )
          )
        )
        .pipe(Effect.asVoid, Effect.mapError(stored))
  })

  return { start, read, advance, on }
}

export const makeReaderPositions = ({
  writer
}: {
  readonly writer: Writer
}): {
  readonly maintenance: ReaderPosition<string | null>
  readonly dailySummary: ReaderPosition<string>
} =>
  ReaderPositions.of({
    maintenance: readerPosition("maintenance").on(writer),
    dailySummary: readerPosition("dailySummary").on(writer)
  })
