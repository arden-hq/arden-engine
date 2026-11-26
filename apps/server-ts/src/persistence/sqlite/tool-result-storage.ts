import { COMPUTER_APP, isComputerStep } from "@arden-hq/protocol/computer"
import { engineOrderedJson } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"
import { Effect, Option, Schema } from "effect"

import {
  managedObjectRefParts,
  type ManagedObjectDescriptor
} from "../managed-output/descriptor.js"
import { ToolResultObjects } from "../managed-output/tool-result-objects.js"
import { decodeJson, encodeJson } from "./json.js"
import { isJsonObject, JsonObjectSchema, type JsonObject } from "../json.js"

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

export const STORED_RESULT_INLINE_BYTES = 16 * 1024
const CONTENT_HEAD_BYTES = 4 * 1024
const INLINE_FIELD_BYTES = 2 * 1024

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
  content_chars: Schema.Int,
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

const characters = (text: string): number => {
  let pairs = 0
  for (let index = 1; index < text.length; index += 1) {
    const low = text.charCodeAt(index)
    const high = text.charCodeAt(index - 1)
    if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) pairs += 1
  }
  return text.length - pairs
}

export const storedResultDigest = (json: string): string | undefined =>
  Option.getOrUndefined(decodeMarker(json))?.stored_result.sha256

export const resultDigest = (result: PersistedToolResult): string => resultObject(result).sha256

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
  const decoded = yield* decodeJson(PersistedToolResultSchema, text).pipe(
    Effect.mapError(
      (cause) =>
        new StoredToolResultError({
          reason: "corrupt",
          message: "Saved tool result is corrupt",
          cause
        })
    )
  )
  const full = withTaggedComputerStep(decoded)
  const evidence = stored.data?.["change_evidence"]
  return evidence === undefined
    ? full
    : { ...full, data: { ...full.data, change_evidence: evidence } }
})

const withTaggedComputerStep = (result: PersistedToolResult): PersistedToolResult => {
  const data = result.data
  const step: unknown = data?.["computer"]
  if (data == null || !isJsonObject(step)) return result
  const storedApp: unknown = step["app"]
  const app = isJsonObject(storedApp) ? storedApp : undefined
  if (app?.["kind"] !== undefined) return result
  const title = step["window"]
  const computer: JsonObject = {
    ...step,
    app:
      app === undefined
        ? { kind: COMPUTER_APP.unidentified }
        : { ...app, kind: COMPUTER_APP.identified },
    window: typeof title === "string" ? { kind: "titled", title } : { kind: "untitled" }
  }
  return isComputerStep(computer) ? { ...result, data: { ...data, computer } } : result
}

export const OMITTING_ROW_SQL = `CASE WHEN json_array_length(result_json, '$.stored_result.omitted') > 0
  THEN result_json END`

export const withWholeDataAndHost = <
  A extends { readonly data?: JsonObject | null; readonly host?: JsonObject }
>(
  projected: A,
  omitting: string | null
): Effect.Effect<A, StoredToolResultError> =>
  omitting === null
    ? Effect.succeed(projected)
    : loadFullResult(omitting).pipe(
        Effect.map((full) => ({
          ...projected,
          ...(full.data === undefined ? {} : { data: full.data }),
          ...(full.host === undefined ? {} : { host: full.host })
        }))
      )

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
