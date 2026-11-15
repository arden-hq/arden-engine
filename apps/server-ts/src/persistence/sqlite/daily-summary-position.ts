import { DateTime, Effect, Schema } from "effect"

import { DAILY_SUMMARY_AUTOMATION_ID } from "../automations/model.js"
import { DailySummaryPosition, DailySummaryPositionError } from "../daily-summary/store.js"
import { automationPositionNamespace } from "./automation-resume.js"
import type { PersistenceDeps } from "./deps.js"

const NAMESPACE = automationPositionNamespace(DAILY_SUMMARY_AUTOMATION_ID)
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
  const encode = (state: { readonly settledDay: string }, operation: Operation) =>
    Schema.encodeUnknownEffect(StateJson)(state).pipe(
      Effect.mapError(failure(operation, "invalid", `Not a calendar day: ${state.settledDay}`))
    )

  const current = Effect.fn("SqliteDailySummaryPosition.current")(function* (startIfUnset: string) {
    const state = yield* encode({ settledDay: startIfUnset }, "read")
    const at = DateTime.formatIso(yield* DateTime.now)
    yield* writer.run(
      sql`INSERT INTO monitor_state (namespace, state, updated_at)
        VALUES (${NAMESPACE}, ${state}, ${at}) ON CONFLICT(namespace) DO NOTHING`.pipe(
        Effect.mapError(failure("read", "storage", "Could not set the Daily Summary position"))
      )
    )
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM monitor_state WHERE namespace = ${NAMESPACE}`.pipe(
      Effect.mapError(failure("read", "storage", "Could not read the Daily Summary position"))
    )
    const row = rows[0]
    if (row === undefined)
      return yield* failure("read", "storage", "The Daily Summary position is not set")()
    const stored = yield* Schema.decodeUnknownEffect(StateJson)(row.state).pipe(
      Effect.mapError(failure("read", "corrupt", "The Daily Summary position is corrupt"))
    )
    return stored.settledDay
  })

  const advance = Effect.fn("SqliteDailySummaryPosition.advance")(function* (input: {
    readonly from: string
    readonly to: string
  }) {
    const to = yield* encode({ settledDay: input.to }, "advance")
    const at = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* writer.run(
      sql<{ readonly namespace: string }>`UPDATE monitor_state SET state = ${to}, updated_at = ${at}
        WHERE namespace = ${NAMESPACE}
          AND json_extract(state, '$.settledDay') IN (${input.from}, ${input.to})
        RETURNING namespace`.pipe(
        Effect.mapError(
          failure("advance", "storage", "Could not advance the Daily Summary position")
        )
      )
    )
    if (rows.length === 0)
      return yield* failure("advance", "conflict", "The Daily Summary position moved")()
  })

  return DailySummaryPosition.of({ current, advance })
}
