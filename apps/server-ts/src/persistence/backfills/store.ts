import { Context, Schema, type Effect } from "effect"

export class BackfillStoreError extends Schema.TaggedError<BackfillStoreError>()(
  "BackfillStoreError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) }
) {}

export interface BackfillProgress {
  readonly name: string
  readonly converted: number
  readonly remaining: number
  readonly finished: boolean
}

export class BackfillStore extends Context.Service<
  BackfillStore,
  {
    readonly run: Effect.Effect<void>
    readonly progress: () => Effect.Effect<ReadonlyArray<BackfillProgress>, BackfillStoreError>
  }
>()("@arden-hq/server/persistence/backfills/BackfillStore") {}
