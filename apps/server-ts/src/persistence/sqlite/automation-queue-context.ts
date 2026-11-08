import { SpaceReviewInputSchema } from "../automations/space-review.js"
import { Schema } from "effect"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { HomeLetterInputSchema } from "../home/model.js"
import { HandlerItemSchema } from "../automations/handler-item.js"

const BatchedEventSchema = Schema.Struct({
  event_type: Schema.NonEmptyString,
  event_key: Schema.NonEmptyString,
  queued_at: Schema.String,
  produced_by: Schema.NullOr(Schema.NonEmptyString),
  chain_depth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  context: Schema.Record(Schema.String, Schema.Json),
  run_only_if: Schema.optionalKey(Schema.NonEmptyArray(Schema.String))
})

const EventBatchSchema = Schema.Struct({
  events: Schema.NonEmptyArray(BatchedEventSchema),
  overflow: Schema.optionalKey(Schema.Array(BatchedEventSchema)),
  omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unchecked: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  paused_since: Schema.optionalKey(Schema.String)
})

export const QueueContextSchema = Schema.Struct({
  scheduled_for: Schema.NullOr(Schema.String),
  automation_run_id: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  trigger_context_snapshot: Schema.optionalKey(AutomationTriggerContextSchema),
  trigger_context: Schema.optionalKey(Schema.String),
  triggering_change: Schema.optionalKey(Schema.String),
  run_only_if: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
  event_batch: Schema.optionalKey(EventBatchSchema),
  from_skipped_run: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  person_change_at: Schema.optionalKey(Schema.String),
  space_review_input: Schema.optionalKey(SpaceReviewInputSchema),
  home_letter_input: Schema.optionalKey(HomeLetterInputSchema),
  handler_item: Schema.optionalKey(HandlerItemSchema)
})
export type QueueContext = typeof QueueContextSchema.Type
