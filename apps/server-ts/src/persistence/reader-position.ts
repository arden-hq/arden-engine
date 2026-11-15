import { Context, type Effect, Schema } from "effect"

export class ReaderPositionError extends Schema.TaggedError<ReaderPositionError>()(
  "ReaderPositionError",
  {
    reason: Schema.Literals(["missing", "corrupt", "invalid", "moved", "storage"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

/** "already_there" when the position is at `next`; "moved" when another writer moved it first. */
export type PositionAdvance = "advanced" | "already_there" | "moved"

/** How far one reader has read. It moves only from where it stands. */
export interface ReaderPosition<A> {
  /** The stored position; stores `initial` when none is stored. */
  readonly start: (initial: A) => Effect.Effect<A, ReaderPositionError>
  readonly read: () => Effect.Effect<A, ReaderPositionError>
  /** Fails with reason "moved" when the position is neither at `expected` nor at `next`. */
  readonly advance: (input: {
    readonly expected: A
    readonly next: A
  }) => Effect.Effect<void, ReaderPositionError>
}

export class ReaderPositions extends Context.Service<
  ReaderPositions,
  {
    /** The last Memory commit Wiki Maintenance reviewed; null before any. */
    readonly maintenance: ReaderPosition<string | null>
    /** The last calendar day (`YYYY-MM-DD`) Daily Summary settled: its page written, already
     * there, nothing to write, or skipped. Each ended day after it is settled in order. */
    readonly dailySummary: ReaderPosition<string>
  }
>()("@arden-hq/server/persistence/ReaderPositions") {}
