import { Schema } from "effect"

const StorageOperationSchema = Schema.Literals([
  "overview",
  "preview",
  "execute",
  "update_settings",
  "tidy"
] as const)

export type StorageOperation = typeof StorageOperationSchema.Type

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: StorageOperationSchema,
  reason: Schema.Literals(["invalid", "not_found", "conflict", "storage"] as const),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const storageError = (
  operation: StorageOperation,
  reason: StorageError["reason"],
  message: string,
  cause?: unknown
): StorageError =>
  new StorageError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })
