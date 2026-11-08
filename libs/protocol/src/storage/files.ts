import { Schema } from "effect"
import { decoderFor } from "../common/boundary.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"

export const StorageFileIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const StorageFileSchema = Schema.Struct({
  id: StorageFileIdSchema,
  name: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  sizeBytes: NonNegativeIntSchema,
  memberCount: PositiveIntSchema,
  kind: Schema.Literals(["file", "directory"]),
  management: Schema.Struct({ action: Schema.Literal("inspect"), reason: Schema.NonEmptyString })
})
export const StorageFilesSchema: Schema.Codec<StorageFiles> = Schema.Struct({
  rootPath: Schema.NonEmptyString,
  files: Schema.Array(StorageFileSchema)
})
export interface StorageFile {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly sizeBytes: number
  readonly memberCount: number
  readonly kind: "file" | "directory"
  readonly management: { readonly action: "inspect"; readonly reason: string }
}
export interface StorageFiles {
  readonly rootPath: string
  readonly files: ReadonlyArray<StorageFile>
}
export const decodeStorageFiles = decoderFor(StorageFilesSchema, "Invalid storage files")
