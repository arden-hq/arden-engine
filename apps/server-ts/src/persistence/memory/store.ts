import { Context, Effect, Schema } from "effect"

const MemoryCaptureProgressSchema = Schema.Struct({
  sequence: Schema.Natural,
  offset: Schema.Natural
})

const MemoryCapturePositionSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Beginning") }),
  Schema.Struct({ _tag: Schema.Literal("AfterSequence"), sequence: Schema.Natural }),
  Schema.Struct({ _tag: Schema.Literal("AtPosition"), progress: MemoryCaptureProgressSchema })
])
export type MemoryCapturePosition = typeof MemoryCapturePositionSchema.Type

export const MemoryCaptureBatchIdentitySchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  start: MemoryCapturePositionSchema,
  end: MemoryCapturePositionSchema,
  endMessageId: Schema.NonEmptyString
})
export type MemoryCaptureBatchIdentity = typeof MemoryCaptureBatchIdentitySchema.Type

export interface MemoryCaptureWork {
  readonly sessionId: string
  readonly position: MemoryCapturePosition
  readonly throughSequence: number
  readonly prepared: MemoryCaptureBatchIdentity | undefined
}

export const MemoryCaptureBatchSchema = Schema.Struct({
  identity: MemoryCaptureBatchIdentitySchema,
  markdown: Schema.NonEmptyString
})
export type MemoryCaptureBatch = typeof MemoryCaptureBatchSchema.Type

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
      older: boolean,
      limit?: number
    ) => Effect.Effect<ReadonlyArray<MemoryCaptureWork>, MemoryCaptureStoreError>
    readonly prepare: (
      batch: MemoryCaptureBatchIdentity
    ) => Effect.Effect<MemoryCaptureMove, MemoryCaptureStoreError>
    readonly advance: (
      batch: MemoryCaptureBatchIdentity
    ) => Effect.Effect<MemoryCaptureMove, MemoryCaptureStoreError>
    readonly skip: (
      batch: MemoryCaptureBatchIdentity
    ) => Effect.Effect<MemoryCaptureMove, MemoryCaptureStoreError>
  }
>()("@arden-hq/server/persistence/memory/MemoryCaptureStore") {}
