import { Context, Effect, Schema } from "effect"

const MemoryCaptureProgressSchema = Schema.Struct({
  sequence: Schema.Natural,
  offset: Schema.Natural
})

/**
 * How far Capture has read a chat. `Beginning`: nothing yet. `AfterSequence`: every message up
 * to and including `sequence`. `AtPosition`: the messages before `progress.sequence`, and the
 * first `progress.offset` characters of that message, which is longer than one batch.
 */
const MemoryCapturePositionSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Beginning") }),
  Schema.Struct({ _tag: Schema.Literal("AfterSequence"), sequence: Schema.Natural }),
  Schema.Struct({ _tag: Schema.Literal("AtPosition"), progress: MemoryCaptureProgressSchema })
])
export type MemoryCapturePosition = typeof MemoryCapturePositionSchema.Type

/**
 * One batch of a chat: from the position Capture had read to, through `end`. The message at the
 * end is named by id because a revert lets later messages reuse its sequence number.
 */
export const MemoryCaptureBatchIdentitySchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  start: MemoryCapturePositionSchema,
  end: MemoryCapturePositionSchema,
  endMessageId: Schema.NonEmptyString
})
export type MemoryCaptureBatchIdentity = typeof MemoryCaptureBatchIdentitySchema.Type

/** A chat with messages Capture has not read, or with a batch it prepared and did not finish. */
export interface MemoryCaptureWork {
  readonly sessionId: string
  readonly position: MemoryCapturePosition
  /**
   * The last message the work may read: the chat's last message when it was listed, or, when a
   * revert cut the prepared batch, the last message of it that is still there.
   */
  readonly throughSequence: number
  readonly prepared: MemoryCaptureBatchIdentity | undefined
}

/** Messages of a chat, `fromSeq` through `throughSeq`, behind its position and not read. */
export interface MemoryCaptureBacklogRange {
  readonly sessionId: string
  readonly fromSeq: number
  readonly throughSeq: number
}

export const MemoryCaptureBatchSchema = Schema.Struct({
  identity: MemoryCaptureBatchIdentitySchema,
  markdown: Schema.NonEmptyString
})
export type MemoryCaptureBatch = typeof MemoryCaptureBatchSchema.Type

/** `superseded`: the chat moved on since the batch was read, so nothing was written. */
export type MemoryCaptureMove = "moved" | "superseded"

export class MemoryCaptureStoreError extends Schema.TaggedError<MemoryCaptureStoreError>()(
  "MemoryCaptureStoreError",
  {
    operation: Schema.Literals(["list", "prepare", "advance", "skip"] as const),
    message: Schema.String,
    sessionId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class MemoryCaptureStore extends Context.Service<
  MemoryCaptureStore,
  {
    readonly listWork: (
      limit?: number
    ) => Effect.Effect<ReadonlyArray<MemoryCaptureWork>, MemoryCaptureStoreError>
    /** Records the batch before the model reads it, if the chat is still at its start. */
    readonly prepare: (
      batch: MemoryCaptureBatchIdentity
    ) => Effect.Effect<MemoryCaptureMove, MemoryCaptureStoreError>
    /**
     * Moves the chat's position from the batch's start to its end, or to the last message of it a
     * revert left.
     */
    readonly advance: (
      batch: MemoryCaptureBatchIdentity
    ) => Effect.Effect<MemoryCaptureMove, MemoryCaptureStoreError>
    /**
     * Moves the position as `advance` does, and puts the batch's messages in the backlog; the
     * range they are in rests a day.
     */
    readonly skip: (
      batch: MemoryCaptureBatchIdentity
    ) => Effect.Effect<MemoryCaptureMove, MemoryCaptureStoreError>
    /** Backlog ranges not resting, the one whose first message is oldest first. */
    readonly listBacklog: () => Effect.Effect<
      ReadonlyArray<MemoryCaptureBacklogRange>,
      MemoryCaptureStoreError
    >
    /**
     * Removes `fromSeq` through `throughSeq` from the range that starts at `fromSeq`, if it
     * still starts there.
     */
    readonly readBacklog: (
      read: MemoryCaptureBacklogRange
    ) => Effect.Effect<void, MemoryCaptureStoreError>
    /** Rests the range that starts at `range.fromSeq` for a day. */
    readonly restBacklog: (
      range: MemoryCaptureBacklogRange
    ) => Effect.Effect<void, MemoryCaptureStoreError>
  }
>()("@arden-hq/server/persistence/memory/MemoryCaptureStore") {}
