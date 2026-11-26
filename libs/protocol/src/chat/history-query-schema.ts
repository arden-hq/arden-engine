import { Schema } from "effect"
import { withExtras } from "../common/schema.js"
import { HISTORY_WINDOW } from "./contracts.js"

const historyLimitSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 100 })
)
const nonNegativeIntegerFromString = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)

const turnWorkWindowQueries = [
  { window: Schema.Literal(HISTORY_WINDOW.latest) },
  { window: Schema.Literal(HISTORY_WINDOW.before), cursor: Schema.NonEmptyString },
  { window: Schema.Literal(HISTORY_WINDOW.after), cursor: Schema.NonEmptyString }
] as const

const historyWindowQueries = [
  ...turnWorkWindowQueries,
  { window: Schema.Literal(HISTORY_WINDOW.around), cursor: Schema.NonEmptyString },
  { window: Schema.Literal(HISTORY_WINDOW.aroundSeq), seq: nonNegativeIntegerFromString }
] as const

export const HistoryQuerySchema = Schema.Union(
  historyWindowQueries.map((window) =>
    withExtras({ session_id: Schema.NonEmptyString, limit: historyLimitSchema, ...window })
  )
)

export const TurnWorkViewSchema = Schema.Literals(["full", "compact"] as const)

export const TurnWorkQuerySchema = Schema.Union(
  turnWorkWindowQueries.map((window) =>
    withExtras({
      session_id: Schema.NonEmptyString,
      turn_id: Schema.NonEmptyString,
      limit: historyLimitSchema,
      view: TurnWorkViewSchema,
      ...window
    })
  )
)
