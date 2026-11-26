import { Schema } from "effect"
import { decoderFor } from "../common/boundary.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"

export const StorageFileIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const STORAGE_FILE_KIND = { file: "file", directory: "directory" } as const

export const StorageFileSchema = Schema.Struct({
  id: StorageFileIdSchema,
  name: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  sizeBytes: NonNegativeIntSchema,
  memberCount: PositiveIntSchema,
  kind: Schema.Literals(Object.values(STORAGE_FILE_KIND)),
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
  readonly kind: (typeof STORAGE_FILE_KIND)[keyof typeof STORAGE_FILE_KIND]
  readonly management: { readonly action: "inspect"; readonly reason: string }
}
export interface StorageFiles {
  readonly rootPath: string
  readonly files: ReadonlyArray<StorageFile>
}
export const decodeStorageFiles = decoderFor(StorageFilesSchema, "Invalid storage files")
