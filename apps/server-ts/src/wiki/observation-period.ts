import { DateTime, Option, Schema } from "effect"

const InstantSchema = Schema.NonEmptyString.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u),
  Schema.makeFilter((value) =>
    Option.isSome(DateTime.make(value)) ? undefined : "Provide a valid ISO timestamp"
  )
)

export const ObservationPeriodSchema = Schema.Struct({
  start: InstantSchema.annotate({
    description: "Observation start, ISO 8601 with Z or an offset."
  }),
  end: InstantSchema.annotate({ description: "Observation end, ISO 8601 with Z or an offset." })
}).check(
  Schema.makeFilter((period) =>
    DateTime.isGreaterThanOrEqualTo(
      DateTime.makeUnsafe(period.end),
      DateTime.makeUnsafe(period.start)
    )
      ? undefined
      : "Observation end must not precede its start"
  )
)

export type ObservationPeriod = typeof ObservationPeriodSchema.Type

export const formatObservationPeriod = (period: ObservationPeriod): string =>
  `${DateTime.formatIso(DateTime.makeUnsafe(period.start))} to ${DateTime.formatIso(DateTime.makeUnsafe(period.end))}`
