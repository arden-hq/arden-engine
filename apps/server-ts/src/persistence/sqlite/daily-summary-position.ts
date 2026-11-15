import { DateTime, Effect, Schema } from "effect"

import { DailySummaryPosition, DailySummaryPositionError } from "../daily-summary/store.js"
import type { PersistenceDeps } from "./deps.js"

const NAMESPACE = "daily_summary"
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))
const StateJson = Schema.fromJsonString(Schema.Struct({ settledDay: Day }))

type Operation = DailySummaryPositionError["operation"]

const failure =
  (operation: Operation, reason: DailySummaryPositionError["reason"], message: string) =>
  (cause?: unknown): DailySummaryPositionError =>
    cause instanceof DailySummaryPositionError
      ? cause
      : new DailySummaryPositionError({
          operation,
          reason,
          message,
          ...(cause === undefined ? {} : { cause })
        })

export const makeDailySummaryPosition = ({
  writer
}: Pick<PersistenceDeps, "writer">): DailySummaryPosition["Service"] => {
  const sql = writer.sql
  const encode = (day: string, operation: Operation) =>
    Schema.encodeUnknownEffect(StateJson)({ settledDay: day }).pipe(
      Effect.mapError(failure(operation, "invalid", `Not a calendar day: ${day}`))
    )
  const read = Effect.fn("SqliteDailySummaryPosition.read")(function* (operation: Operation) {
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM monitor_state WHERE namespace = ${NAMESPACE}`.pipe(
      Effect.mapError(failure(operation, "storage", "Could not read the Daily Summary position"))
    )
    const row = rows[0]
    if (row === undefined)
      return yield* failure(operation, "storage", "The Daily Summary position is not set")()
    const state = yield* Schema.decodeUnknownEffect(StateJson)(row.state).pipe(
      Effect.mapError(failure(operation, "corrupt", "The Daily Summary position is corrupt"))
    )
    return state.settledDay
  })

  const initialize = Effect.fn("SqliteDailySummaryPosition.initialize")(function* (day: string) {
    const state = yield* encode(day, "initialize")
    const at = DateTime.formatIso(yield* DateTime.now)
    yield* writer.run(
      sql`INSERT INTO monitor_state (namespace, state, updated_at)
        VALUES (${NAMESPACE}, ${state}, ${at}) ON CONFLICT(namespace) DO NOTHING`.pipe(
        Effect.mapError(
          failure("initialize", "storage", "Could not set the Daily Summary position")
        )
      )
    )
    return yield* read("initialize")
  })

  const advance = Effect.fn("SqliteDailySummaryPosition.advance")(function* (input: {
    readonly from: string
    readonly to: string
  }) {
    const from = yield* encode(input.from, "advance")
    const to = yield* encode(input.to, "advance")
    const at = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* writer.run(
      sql<{ readonly namespace: string }>`UPDATE monitor_state SET state = ${to}, updated_at = ${at}
        WHERE namespace = ${NAMESPACE} AND state IN (${from}, ${to})
        RETURNING namespace`.pipe(
        Effect.mapError(
          failure("advance", "storage", "Could not advance the Daily Summary position")
        )
      )
    )
    if (rows.length === 0)
      return yield* failure("advance", "conflict", "The Daily Summary position moved")()
  })

  return DailySummaryPosition.of({ initialize, settled: () => read("read"), advance })
}
