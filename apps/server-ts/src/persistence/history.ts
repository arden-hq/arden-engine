import { Schema } from "effect"
export {
  RECORDED_HISTORY_ENTRY_KIND,
  RECORDED_HISTORY_NEXT,
  RECORDED_HISTORY_THROUGH,
  RecordedHistoryEntrySchema,
  RecordedHistoryPageSchema,
  RecordedHistoryQuerySchema,
  RecordedHistoryHttpQuerySchema
} from "@arden-hq/protocol/effect/history"
export type { RecordedHistoryInput, RecordedHistoryPage } from "@arden-hq/protocol/history"

export const RECORDED_HISTORY_ERROR_TAG = "RecordedHistoryError"

export class RecordedHistoryError extends Schema.TaggedError<RecordedHistoryError>()(
  RECORDED_HISTORY_ERROR_TAG,
  {
    reason: Schema.Literals(["invalid", "not_found", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}
