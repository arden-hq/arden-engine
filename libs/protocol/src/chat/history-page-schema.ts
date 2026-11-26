import { Schema } from "effect"
import { NonNegativeIntSchema, withExtras } from "../common/schema.js"
import { PAGE_BOUNDS, TOOL_COUNT_NAME, TURN_ENDING } from "./history.js"

export const HistoryPageSchema = withExtras({
  has_more_before: Schema.Boolean,
  has_more_after: Schema.Boolean,
  bounds: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(PAGE_BOUNDS.empty) }),
    Schema.Struct({
      kind: Schema.Literal(PAGE_BOUNDS.bounded),
      before: Schema.String,
      after: Schema.String
    })
  ])
})

export const TurnShellSchema = withExtras({
  turn_id: Schema.NonEmptyString,
  message_start_seq: NonNegativeIntSchema,
  message_end_seq: NonNegativeIntSchema,
  started_at: Schema.String,
  ended_at: Schema.String,
  has_work: Schema.Boolean,
  has_tool_work: Schema.Boolean,
  tool_calls: Schema.Array(
    withExtras({
      name: Schema.String,
      display_name: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(TOOL_COUNT_NAME.unnamed) }),
        Schema.Struct({ kind: Schema.Literal(TOOL_COUNT_NAME.named), text: Schema.String })
      ]),
      count: NonNegativeIntSchema,
      rejected: NonNegativeIntSchema,
      seqs: Schema.Array(NonNegativeIntSchema)
    })
  ),
  ending: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(TURN_ENDING.ended) }),
    Schema.Struct({
      kind: Schema.Literal(TURN_ENDING.failed),
      code: Schema.String,
      message: Schema.String
    })
  ])
})
