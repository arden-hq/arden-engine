import { Context, Effect, Schema } from "effect"

export const MemoryCaptureProgressSchema = Schema.Struct({
  sequence: Schema.Natural,
  offset: Schema.Natural
})

export type MemoryCaptureProgress = typeof MemoryCaptureProgressSchema.Type

const MemoryCaptureStartSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Beginning") }),
  Schema.Struct({ _tag: Schema.Literal("AfterSequence"), sequence: Schema.Natural }),
  Schema.Struct({ _tag: Schema.Literal("AtPosition"), progress: MemoryCaptureProgressSchema })
])
export type MemoryCaptureStart = typeof MemoryCaptureStartSchema.Type

export const MemoryCaptureBatchIdentitySchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  contextGeneration: Schema.Natural,
  start: MemoryCaptureStartSchema,
  end: MemoryCaptureProgressSchema
})
export type MemoryCaptureBatchIdentity = typeof MemoryCaptureBatchIdentitySchema.Type

export const PreparedMemoryCaptureBatchSchema = Schema.Struct({
  identity: MemoryCaptureBatchIdentitySchema,
  runIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  final: Schema.Boolean
})
export type PreparedMemoryCaptureBatch = typeof PreparedMemoryCaptureBatchSchema.Type

export const MemoryCaptureJobSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  contextGeneration: Schema.Natural,
  throughSequence: Schema.Natural,
  progress: Schema.optionalKey(MemoryCaptureProgressSchema),
  prepared: Schema.optionalKey(PreparedMemoryCaptureBatchSchema)
})

export type MemoryCaptureJob = (typeof MemoryCaptureJobSchema)["Type"]

export const MemoryCaptureBatchSchema = Schema.Struct({
  identity: MemoryCaptureBatchIdentitySchema,
  markdown: Schema.NonEmptyString,
  jobs: Schema.Array(MemoryCaptureJobSchema).check(Schema.isMinLength(1)),
  final: Schema.Boolean
})
export type MemoryCaptureBatch = typeof MemoryCaptureBatchSchema.Type

export class MemoryCaptureStoreError extends Schema.TaggedError<MemoryCaptureStoreError>()(
  "MemoryCaptureStoreError",
  {
    operation: Schema.Literals(["list", "cursor", "prepare", "advance", "complete"] as const),
    message: Schema.String,
    runId: Schema.optionalKey(Schema.NonEmptyString),
    sessionId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class MemoryCaptureStore extends Context.Service<
  MemoryCaptureStore,
  {
    readonly listPending: (
      limit?: number
    ) => Effect.Effect<ReadonlyArray<MemoryCaptureJob>, MemoryCaptureStoreError>
    readonly cursor: (
      sessionId: string,
      contextGeneration: number
    ) => Effect.Effect<number, MemoryCaptureStoreError>
    readonly prepare: (
      job: MemoryCaptureJob,
      prepared: PreparedMemoryCaptureBatch
    ) => Effect.Effect<void, MemoryCaptureStoreError>
    readonly advance: (
      job: MemoryCaptureJob,
      progress: MemoryCaptureProgress
    ) => Effect.Effect<void, MemoryCaptureStoreError>
    readonly complete: (job: MemoryCaptureJob) => Effect.Effect<void, MemoryCaptureStoreError>
  }
>()("@arden-hq/server/persistence/memory/MemoryCaptureStore") {}
