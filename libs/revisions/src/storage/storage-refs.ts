import { Effect, Schema } from "effect"

import { RevisionStorageError } from "../domain/errors.js"
import { storageFailure } from "./files.js"
import { type StorageError } from "./service-types.js"

export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

export const defaultLockStaleAfterMs = 10 * 60 * 1000
export const minimumLockStaleAfterMs = 5_000
export const metadataScanConcurrency = 16

export const encodeRef = (commitId: string): Uint8Array =>
  new TextEncoder().encode(`{"commit_id":"${commitId}","version":2}\n`)

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export const decodeRefId = Effect.fn("RevisionStorage.decodeRefId")(function* (
  content: Uint8Array
): Effect.fn.Return<string, StorageError> {
  const record: unknown = yield* Effect.try({
    try: () => decodeJsonText(new TextDecoder("utf-8", { fatal: true }).decode(content)),
    catch: (cause) => storageFailure("decode current ref", cause)
  })
  if (typeof record !== "object" || record === null || Array.isArray(record))
    return yield* new RevisionStorageError({ message: "decode current ref: invalid ref shape" })
  const value = record as Record<string, unknown>
  if (value.version !== 2) {
    return yield* new RevisionStorageError({
      message: `decode current ref: unsupported format ${String(value.version)}`
    })
  }
  if (
    typeof value.commit_id !== "string" ||
    value.commit_id.length !== 64 ||
    [...value.commit_id].some((char) => !"0123456789abcdef".includes(char))
  ) {
    return yield* new RevisionStorageError({ message: "decode current ref: invalid ref shape" })
  }
  if (bytesEqual(content, encodeRef(value.commit_id)) === false) {
    return yield* new RevisionStorageError({
      message: "decode current ref: current ref is not canonical"
    })
  }
  return value.commit_id
})
