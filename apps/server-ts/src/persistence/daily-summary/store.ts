import { Context, type Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

export class DailySummaryPositionError extends Schema.TaggedError<DailySummaryPositionError>()(
  "DailySummaryPositionError",
  {
    ...storeErrorFields({
      operations: ["read", "tried", "advance"],
      reasons: ["invalid", "conflict", "corrupt", "storage"]
    })
  }
) {}

/** The last calendar day (`YYYY-MM-DD`) Daily Summary settled: its page written, already there,
 * or nothing to write. Each ended day after it is settled in order. `tries` counts the jobs that
 * started a run on the next day without settling it. */
export interface DailySummaryPlace {
  readonly settledDay: string
  readonly tries: number
}

export class DailySummaryPosition extends Context.Service<
  DailySummaryPosition,
  {
    /** The stored position; stores `startIfUnset` with no tries when none is stored. */
    readonly current: (
      startIfUnset: string
    ) => Effect.Effect<DailySummaryPlace, DailySummaryPositionError>
    /** Counts one more job that started a run on the day after `settled`. */
    readonly tried: (settled: string) => Effect.Effect<void, DailySummaryPositionError>
    readonly advance: (input: {
      readonly from: string
      readonly to: string
    }) => Effect.Effect<void, DailySummaryPositionError>
  }
>()("@arden-hq/server/persistence/daily-summary/DailySummaryPosition") {}
