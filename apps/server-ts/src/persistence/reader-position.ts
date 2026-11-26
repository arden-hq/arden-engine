import { Context, type Effect, Schema } from "effect"

export class ReaderPositionError extends Schema.TaggedError<ReaderPositionError>()(
  "ReaderPositionError",
  {
    reason: Schema.Literals(["missing", "corrupt", "invalid", "moved", "storage"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type PositionAdvance = "advanced" | "already_there" | "moved"

export interface ReaderPosition<A> {
  readonly start: (initial: A) => Effect.Effect<A, ReaderPositionError>
  readonly read: () => Effect.Effect<A, ReaderPositionError>
  readonly advance: (input: {
    readonly expected: A
    readonly next: A
  }) => Effect.Effect<void, ReaderPositionError>
}

export class ReaderPositions extends Context.Service<
  ReaderPositions,
  {
    readonly maintenance: ReaderPosition<string | null>
    readonly dailySummary: ReaderPosition<string>
  }
>()("@arden-hq/server/persistence/ReaderPositions") {}
