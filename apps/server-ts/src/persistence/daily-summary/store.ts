import { Context, type Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

export class DailySummaryPositionError extends Schema.TaggedError<DailySummaryPositionError>()(
  "DailySummaryPositionError",
  {
    ...storeErrorFields({
      operations: ["read", "advance"],
      reasons: ["invalid", "conflict", "corrupt", "storage"]
    })
  }
) {}

/** The last calendar day (`YYYY-MM-DD`) Daily Summary settled: its page written, already there,
 * nothing to write, or skipped. Each ended day after it is settled in order. */
export class DailySummaryPosition extends Context.Service<
  DailySummaryPosition,
  {
    /** The stored position; stores `startIfUnset` when none is stored. */
    readonly current: (startIfUnset: string) => Effect.Effect<string, DailySummaryPositionError>
    readonly advance: (input: {
      readonly from: string
      readonly to: string
    }) => Effect.Effect<void, DailySummaryPositionError>
  }
>()("@arden-hq/server/persistence/daily-summary/DailySummaryPosition") {}
