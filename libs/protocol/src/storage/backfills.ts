import { Schema } from "effect"
import { decoderFor } from "../common/boundary.js"
import { NonNegativeIntSchema } from "../common/schema.js"

/** One background data backfill: rows converted so far and rows still in the old shape. */
export interface StorageBackfill {
  readonly name: string
  readonly converted: number
  readonly remaining: number
  readonly finished: boolean
}

export interface StorageBackfills {
  readonly backfills: ReadonlyArray<StorageBackfill>
}

export const StorageBackfillsSchema: Schema.Codec<StorageBackfills> = Schema.Struct({
  backfills: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      converted: NonNegativeIntSchema,
      remaining: NonNegativeIntSchema,
      finished: Schema.Boolean
    })
  )
})

export const decodeStorageBackfills = decoderFor(
  StorageBackfillsSchema,
  "Invalid storage backfills"
)
