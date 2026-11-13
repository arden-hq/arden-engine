import { engineOrderedJson } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"
import { Effect, Option, Schema } from "effect"

import {
  managedObjectRefParts,
  type ManagedObjectDescriptor
} from "../managed-output/descriptor.js"
import { ToolResultObjects } from "../managed-output/tool-result-objects.js"
import { decodeJson, encodeJson } from "./json.js"
import { JsonObjectSchema } from "../json.js"

const ContentBlockSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    media_type: Schema.String,
    data: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("audio"),
    media_type: Schema.String,
    data: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("context"),
    content_type: Schema.String,
    content: Schema.optionalKey(Schema.NullOr(Schema.String)),
    metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
  })
])

export const PersistedToolResultSchema = Schema.Struct({
  content: Schema.String,
  preview: Schema.String,
  is_error: Schema.optionalKey(Schema.Boolean),
  retryable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  data: Schema.optionalKey(Schema.NullOr(JsonObjectSchema)),
  message_extras: Schema.optionalKey(JsonObjectSchema),
  host: Schema.optionalKey(JsonObjectSchema),
  model_content: Schema.optionalKey(Schema.Array(ContentBlockSchema))
})

export type PersistedToolResult = (typeof PersistedToolResultSchema)["Type"]

/**
 * A result whose JSON is larger than this is kept whole as a managed object
 * owned by its chat, and `tool_calls.result_json` holds a slim row in the same
 * shape. Rows up to 16 KB (three in four, measured) stay as they are; the rows
 * above it hold two thirds of the stored text.
 */
export const STORED_RESULT_INLINE_BYTES = 16 * 1024
const CONTENT_HEAD_BYTES = 4 * 1024
const INLINE_FIELD_BYTES = 2 * 1024

/**
 * Data fields a slim row keeps whatever their size: the ones SQL reads in
 * place from `result_json` (keep this list in step with those queries; the
 * slim-row test reads each of them), and `change_evidence`, which is projected
 * when the row is written and so is not part of the stored object.
 */
const INLINE_DATA_FIELDS: ReadonlySet<string> = new Set([
  "applied_change",
  "attachment_id",
  "automation_ref",
  "change_evidence",
  "comment",
  "decision",
  "exit_code",
  "final_url",
  "finish_check",
  "outcome",
  "proposal",
  "requested_url",
  "source_refs"
])

const StoredResultMarkerSchema = Schema.Struct({
  ref: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int,
  /** Characters in the whole `content`, as SQLite's length() counts them. */
  content_chars: Schema.Int,
  /** Fields left out of the slim row, such as `data.text` or `message_extras`. */
  omitted: Schema.Array(Schema.String)
})

const StoredToolResultSchema = Schema.Struct({
  ...PersistedToolResultSchema.fields,
  stored_result: Schema.optionalKey(StoredResultMarkerSchema)
})

type StoredToolResult = (typeof StoredToolResultSchema)["Type"]

export class StoredToolResultError extends Schema.TaggedError<StoredToolResultError>()(
  "StoredToolResultError",
  {
    reason: Schema.Literals(["corrupt", "unavailable"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

interface ResultObject {
  readonly text: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * The text kept as the managed object: the whole result with sorted keys, so
 * equal results have one digest. `change_evidence` is left out because it is
 * projected inside the writing transaction, after the object is published.
 */
const resultObject = (result: PersistedToolResult): ResultObject => {
  const text = engineOrderedJson(withoutChangeEvidence(result))
  return { text, sha256: sha256Hex(text), bytes: Buffer.byteLength(text, "utf8") }
}

export const withoutChangeEvidence = (result: PersistedToolResult): PersistedToolResult => {
  if (result.data == null || !("change_evidence" in result.data)) return result
  const { change_evidence: _evidence, ...data } = result.data
  const { data: _data, ...rest } = result
  return { ...rest, ...(Object.keys(data).length === 0 ? {} : { data }) }
}

/**
 * Publishes the whole result as a managed object when it is over the inline
 * limit. Runs before the transaction that writes the row, so the object exists
 * before the row that names it commits. Returns undefined when the row stays
 * whole.
 */
export const publishLargeToolResult = Effect.fn("ToolResultStorage.publish")(function* (
  call: { readonly sessionId: string; readonly toolName: string; readonly toolCallId: string },
  result: PersistedToolResult
): Effect.fn.Return<ManagedObjectDescriptor | undefined, StoredToolResultError> {
  const object = resultObject(result)
  if (object.bytes <= STORED_RESULT_INLINE_BYTES) return undefined
  const store = yield* ToolResultObjects
  if (store === undefined) return undefined
  return yield* Effect.tryPromise({
    try: () => store.publish({ ...call, text: object.text }),
    catch: (cause) =>
      new StoredToolResultError({
        reason: "unavailable",
        message: "Could not save the whole tool result",
        cause
      })
  })
})

/**
 * The `result_json` to write for `result`. Slim only when `published` is the
 * object of this very result; any other result is written whole, so a row
 * never names an object that does not hold it.
 */
export const storedResultJson = (
  result: PersistedToolResult,
  published: ManagedObjectDescriptor | undefined
): Effect.Effect<string, StoredToolResultError> => {
  const object = published === undefined ? undefined : resultObject(result)
  const stored: StoredToolResult =
    published !== undefined &&
    object?.sha256 === published.sha256 &&
    object.bytes === published.bytes
      ? slimResult(result, published)
      : result
  return encodeJson(StoredToolResultSchema, stored).pipe(
    Effect.mapError(
      (cause) =>
        new StoredToolResultError({
          reason: "corrupt",
          message: "Tool result must be JSON-safe",
          cause
        })
    )
  )
}

const slimResult = (
  result: PersistedToolResult,
  published: ManagedObjectDescriptor
): StoredToolResult => {
  const data = Object.entries(result.data ?? {})
  const kept = data.filter(([key, value]) => INLINE_DATA_FIELDS.has(key) || fits(value))
  const extras = result.message_extras
  const keepsExtras = extras !== undefined && fits(extras)
  const omitted = [
    ...data.filter(([key]) => !kept.some(([name]) => name === key)).map(([key]) => `data.${key}`),
    ...(extras === undefined || keepsExtras ? [] : ["message_extras"])
  ]
  return {
    content: head(result.content, CONTENT_HEAD_BYTES),
    preview: head(result.preview, CONTENT_HEAD_BYTES),
    ...(result.is_error === undefined ? {} : { is_error: result.is_error }),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    ...(result.data === undefined
      ? {}
      : { data: result.data === null ? null : Object.fromEntries(kept) }),
    ...(keepsExtras ? { message_extras: extras } : {}),
    ...(result.host === undefined ? {} : { host: result.host }),
    model_content: [],
    stored_result: {
      ref: published.ref,
      sha256: published.sha256,
      bytes: published.bytes,
      content_chars: characters(result.content),
      omitted
    }
  }
}

const fits = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), "utf8") <= INLINE_FIELD_BYTES

/** The longest prefix of whole characters within `maxBytes` of UTF-8. */
const head = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const character of text) {
    bytes += Buffer.byteLength(character, "utf8")
    if (bytes > maxBytes) break
    end += character.length
  }
  return text.slice(0, end)
}

/** Code points, as SQLite's length() counts a text value. */
const characters = (text: string): number => {
  let pairs = 0
  for (let index = 1; index < text.length; index += 1) {
    const low = text.charCodeAt(index)
    const high = text.charCodeAt(index - 1)
    if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) pairs += 1
  }
  return text.length - pairs
}

/** The digest of a slim row's whole result, without reading the object; undefined for a whole row. */
export const storedResultDigest = (json: string): string | undefined =>
  Option.getOrUndefined(decodeMarker(json))?.stored_result.sha256

/** The digest `result` would be stored under. */
export const resultDigest = (result: PersistedToolResult): string => resultObject(result).sha256

/**
 * The whole result a `result_json` row holds: the row itself, or, for a slim
 * row, the object it names (verified against its digest) with the row's
 * `change_evidence`.
 */
export const loadFullResult = Effect.fn("ToolResultStorage.loadFull")(function* (
  json: string
): Effect.fn.Return<PersistedToolResult, StoredToolResultError> {
  const stored = yield* decodeStoredRow(json)
  const marker = stored.stored_result
  if (marker === undefined) return stored
  const store = yield* ToolResultObjects
  if (store === undefined)
    return yield* new StoredToolResultError({
      reason: "unavailable",
      message: "The whole tool result is saved outside the database, which is not open"
    })
  if (managedObjectRefParts(marker.ref)?.digest !== marker.sha256)
    return yield* new StoredToolResultError({
      reason: "corrupt",
      message: "Stored tool result names an object that does not match its digest"
    })
  const text = yield* Effect.tryPromise({
    try: () => store.read(marker.ref),
    catch: (cause) =>
      new StoredToolResultError({
        reason: "unavailable",
        message: "Could not read the whole tool result",
        cause
      })
  })
  const full = yield* decodeJson(PersistedToolResultSchema, text).pipe(
    Effect.mapError(
      (cause) =>
        new StoredToolResultError({
          reason: "corrupt",
          message: "Saved tool result is corrupt",
          cause
        })
    )
  )
  const evidence = stored.data?.["change_evidence"]
  return evidence === undefined
    ? full
    : { ...full, data: { ...full.data, change_evidence: evidence } }
})

/**
 * The whole result as JSON text, for readers that parse `result_json`
 * themselves. A row without the marker is returned as it is, unchecked.
 */
export const fullResultJson = (json: string): Effect.Effect<string, StoredToolResultError> =>
  Option.isNone(decodeMarker(json))
    ? Effect.succeed(json)
    : loadFullResult(json).pipe(Effect.map((full) => JSON.stringify(full)))

const decodeMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ stored_result: StoredResultMarkerSchema }))
)

const decodeStoredRow = (json: string): Effect.Effect<StoredToolResult, StoredToolResultError> =>
  decodeJson(StoredToolResultSchema, json).pipe(
    Effect.mapError(
      (cause) =>
        new StoredToolResultError({
          reason: "corrupt",
          message: "Stored tool result is corrupt",
          cause
        })
    )
  )
