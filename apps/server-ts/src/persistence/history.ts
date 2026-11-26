import { Schema } from "effect"
export {
  RECORDED_HISTORY_NEXT,
  RECORDED_HISTORY_THROUGH,
  RecordedHistoryEntrySchema,
  RecordedHistoryPageSchema,
  RecordedHistoryQuerySchema,
  RecordedHistoryHttpQuerySchema
} from "@arden-hq/protocol/effect/history"
export type { RecordedHistoryInput, RecordedHistoryPage } from "@arden-hq/protocol/history"

export class RecordedHistoryError extends Schema.TaggedError<RecordedHistoryError>()(
  "RecordedHistoryError",
  {
    reason: Schema.Literals(["invalid", "not_found", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}
