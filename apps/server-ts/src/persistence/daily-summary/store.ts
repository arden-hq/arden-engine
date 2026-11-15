import { Context, type Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

export class DailySummaryPositionError extends Schema.TaggedError<DailySummaryPositionError>()(
  "DailySummaryPositionError",
  {
    ...storeErrorFields({
      operations: ["initialize", "read", "advance"],
      reasons: ["invalid", "conflict", "corrupt", "storage"]
    })
  }
) {}

/** The last calendar day (`YYYY-MM-DD`) Daily Summary settled: its page written, already there,
 * or nothing to write. Each ended day after it is settled in order. */
export class DailySummaryPosition extends Context.Service<
  DailySummaryPosition,
  {
    /** Stores `day` only when no position is stored yet; returns the stored one. */
    readonly initialize: (day: string) => Effect.Effect<string, DailySummaryPositionError>
    readonly settled: () => Effect.Effect<string, DailySummaryPositionError>
    readonly advance: (input: {
      readonly from: string
      readonly to: string
    }) => Effect.Effect<void, DailySummaryPositionError>
  }
>()("@arden-hq/server/persistence/daily-summary/DailySummaryPosition") {}
