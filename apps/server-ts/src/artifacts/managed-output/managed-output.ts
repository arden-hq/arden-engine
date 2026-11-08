import {
  truncateToolResult,
  type JsonObject,
  type JsonValue,
  type ToolResult
} from "@arden-hq/loop"
import { Context, Effect, Layer, Predicate } from "effect"

import { ManagedOutputLifecycleStore } from "../../persistence/managed-output/lifecycle-store.js"

import {
  isManagedObjectSource,
  managedObjectRefParts,
  readManagedObjectDescriptor,
  type ManagedObjectDescriptor,
  type ManagedObjectSource
} from "../../persistence/managed-output/descriptor.js"
import { makeManagedObjectStore, type ManagedObjectStore } from "./object-store.js"

const INLINE_LIMIT = { maxBytes: 50 * 1024, maxLines: 2_000 } as const
const PREVIEW_LIMIT = { maxBytes: 32 * 1024, maxLines: 1_200 } as const
const LABEL_LIMIT = { maxBytes: 1_024, maxLines: 20 } as const
const MAX_INLINE_DATA_BYTES = 16 * 1024
const MAX_SOURCE_REFS = 64
const MAX_SOURCE_REFS_BYTES = 1024 * 1024

type ManagedOutputSource = ManagedObjectSource
export type ManagedOutputDescriptor = ManagedObjectDescriptor

export const readManagedOutputDescriptor = (value: unknown): ManagedOutputDescriptor | null =>
  readManagedObjectDescriptor(value) ?? null

type ManagedTextResult =
  | { readonly status: "inline"; readonly content: string; readonly descriptor: null }
  | {
      readonly status: "localized"
      readonly content: string
      readonly descriptor: ManagedOutputDescriptor
    }

export interface ManagedOutputWriter {
  readonly read: ManagedObjectStore["read"]
  readonly ownerDigests: ManagedObjectStore["ownerDigests"]
  readonly removeOwner: ManagedObjectStore["removeOwner"]
  readonly collectDigest: ManagedObjectStore["collectDigest"]
  readonly size: ManagedObjectStore["size"]
  readonly removeFromSession: (input: {
    readonly sessionId: string
    readonly ref: string
  }) => Promise<boolean>
  readonly localizeText: (input: {
    readonly sessionId: string
    readonly text: string
    readonly source: ManagedOutputSource
    readonly format?: "text" | "json"
    readonly force?: boolean
  }) => Promise<ManagedTextResult>
  readonly localizeToolResult: (input: {
    readonly sessionId: string
    readonly result: ToolResult
    readonly source: ManagedOutputSource
  }) => Promise<ToolResult>
  readonly copyToSession: (input: {
    readonly descriptor: ManagedOutputDescriptor
    readonly sessionId: string
    readonly source?: ManagedOutputSource
  }) => Promise<ManagedTextResult>
}

const descriptorText = (descriptor: ManagedOutputDescriptor): string =>
  [
    "[Full output saved as a private managed object.]",
    `Reference: ${descriptor.ref}`,
    `SHA-256: ${descriptor.sha256}`,
    `Bytes: ${descriptor.bytes}`,
    `Format: ${descriptor.format}`,
    `Use file_read with ${JSON.stringify({ path: descriptor.ref, offset: 1, limit: 400 })} to inspect it.`
  ].join("\n")

const localizedPreview = (text: string, descriptor: ManagedOutputDescriptor): string => {
  const preview = truncateToolResult(text, PREVIEW_LIMIT)
  return `${preview.length === 0 ? "(No textual preview.)" : preview}\n\n${descriptorText(descriptor)}`
}

const SOURCE_REF_FIELDS = [
  "provider",
  "kind",
  "ref",
  "path",
  "title",
  "url",
  "uri",
  "mime_type",
  "server",
  "tool",
  "published_at",
  "sha256",
  "format",
  "owner_session_hash",
  "snapshot_ref",
  "revision",
  "bytes"
] as const

const compactSourceRef = (value: unknown): JsonValue | null => {
  if (!Predicate.isObject(value)) return null
  const compact: Record<string, JsonValue> = {}
  for (const field of SOURCE_REF_FIELDS) {
    if (!(field in value)) continue
    const next = value[field]
    if (typeof next === "string") {
      const locator = field === "ref" || field === "path" || field === "url" || field === "uri"
      let limit = 256
      if (locator) limit = 8192
      else if (field === "title") limit = 512
      compact[field] = next.slice(0, limit)
    } else if (typeof next === "number" && Number.isFinite(next)) compact[field] = next
    else if (typeof next === "boolean" || next === null) compact[field] = next
  }
  if ("source" in value && isManagedObjectSource(value.source)) {
    compact["source"] = value.source
  }
  return Object.keys(compact).length === 0 ? null : compact
}

const compactSourceRefs = (value: unknown): ReadonlyArray<JsonValue> | undefined => {
  if (!Array.isArray(value)) return undefined
  const refs: JsonValue[] = []
  let bytes = 0
  for (const candidate of value) {
    const compact = compactSourceRef(candidate)
    if (compact === null) continue
    const next = Buffer.byteLength(JSON.stringify(compact), "utf8")
    if (refs.length >= MAX_SOURCE_REFS || bytes + next > MAX_SOURCE_REFS_BYTES) break
    refs.push(compact)
    bytes += next
  }
  return refs.length === 0 ? undefined : refs
}

const jsonBytes = (value: JsonValue): number => Buffer.byteLength(JSON.stringify(value), "utf8")

const spilledData = (data: JsonObject, pinned: JsonObject): JsonObject => {
  const sized = Object.entries(data)
    .filter(([key]) => !(key in pinned))
    .map(([key, value]) => ({ key, value, bytes: jsonBytes(value) }))
    .toSorted((a, b) => a.bytes - b.bytes)
  let room = MAX_INLINE_DATA_BYTES - jsonBytes(pinned) - jsonBytes(sized.map((field) => field.key))
  const kept: Record<string, JsonValue> = {}
  const omitted: Array<string> = []
  for (const field of sized) {
    if (field.bytes > room) {
      omitted.push(field.key)
      continue
    }
    kept[field.key] = field.value
    room -= field.bytes
  }
  return { ...kept, ...pinned, ...(omitted.length === 0 ? {} : { omitted_keys: omitted }) }
}

type OutputLifecycle = Pick<
  ManagedOutputLifecycleStore["Service"],
  "withLiveSession" | "forgetOutput" | "completeGc"
>

const unfenced: OutputLifecycle = {
  withLiveSession: (_sessionId, action) => action(),
  forgetOutput: (input) => input.remove(),
  completeGc: async (_sessionId, _digest, action) => {
    await action()
    return true
  }
}

const makeManagedOutputWriter = (
  root: string,
  lifecycle: OutputLifecycle = unfenced
): ManagedOutputWriter => {
  const objects = makeManagedObjectStore(root)
  const fence = lifecycle.withLiveSession

  const removeFromSession: ManagedOutputWriter["removeFromSession"] = async (input) => {
    const parsed = managedObjectRefParts(input.ref)
    if (parsed === undefined) throw new Error("Managed-output ref is invalid")
    const removed = await lifecycle.forgetOutput({
      sessionId: input.sessionId,
      digest: parsed.digest,
      remove: () => objects.removeRef(input)
    })
    await lifecycle.completeGc(input.sessionId, parsed.digest, async () => {
      await objects.collectDigest(parsed.digest)
    })
    return removed
  }

  const localizeText: ManagedOutputWriter["localizeText"] = async (input) => {
    if (input.force !== true && truncateToolResult(input.text, INLINE_LIMIT) === input.text) {
      return { status: "inline", content: input.text, descriptor: null }
    }
    const descriptor = await fence(input.sessionId, () =>
      objects.publish({
        sessionId: input.sessionId,
        text: input.text,
        format: input.format ?? "text",
        source: input.source
      })
    )
    return { status: "localized", content: localizedPreview(input.text, descriptor), descriptor }
  }

  const copyToSession: ManagedOutputWriter["copyToSession"] = async (input) => {
    const descriptor = await fence(input.sessionId, () => objects.attach(input))
    const text = await objects.read({ sessionId: input.sessionId, ref: descriptor.ref })
    return { status: "localized", content: localizedPreview(text, descriptor), descriptor }
  }

  const localizeToolResult: ManagedOutputWriter["localizeToolResult"] = async (input) => {
    const dataText = input.result.data == null ? null : JSON.stringify(input.result.data)
    const oversizedContent =
      truncateToolResult(input.result.content, INLINE_LIMIT) !== input.result.content
    const oversizedData =
      dataText !== null && Buffer.byteLength(dataText, "utf8") > MAX_INLINE_DATA_BYTES
    if (!oversizedContent && !oversizedData) return input.result
    let payload = input.result.content
    if (oversizedData) {
      payload = oversizedContent
        ? JSON.stringify({ content: input.result.content, data: input.result.data })
        : dataText
    }
    const localized = await localizeText({
      sessionId: input.sessionId,
      text: payload,
      source: input.source,
      format: oversizedData ? "json" : "text",
      force: true
    })
    if (localized.descriptor === null)
      throw new Error("Managed-output publication did not return a descriptor")
    const descriptor = localized.descriptor
    const compactDescriptor = compactSourceRef(descriptor)
    if (compactDescriptor === null) throw new Error("Managed-output descriptor is invalid")
    const sourceRefs = compactSourceRefs(input.result.data?.["source_refs"])
    const hostRefs = compactSourceRefs(input.result.host?.["source_refs"]) ?? []
    const managedRef = {
      ...descriptor,
      provider: "arden",
      title: "Saved full output",
      use: "work"
    }
    return {
      ...input.result,
      content:
        oversizedData && !oversizedContent
          ? [
              truncateToolResult(input.result.content, PREVIEW_LIMIT),
              descriptorText(descriptor)
            ].join("\n\n")
          : localized.content,
      preview: truncateToolResult(input.result.preview, LABEL_LIMIT),
      ...(oversizedData
        ? {
            data: spilledData(input.result.data ?? {}, {
              managed_output: compactDescriptor,
              ...(sourceRefs === undefined ? {} : { source_refs: sourceRefs })
            })
          }
        : {}),
      host: {
        ...input.result.host,
        managed_output: compactDescriptor,
        source_refs: [...hostRefs, managedRef]
      }
    }
  }

  return {
    read: objects.read,
    ownerDigests: objects.ownerDigests,
    removeOwner: objects.removeOwner,
    collectDigest: objects.collectDigest,
    removeFromSession,
    size: objects.size,
    localizeText,
    localizeToolResult,
    copyToSession
  }
}

export class ManagedOutputs extends Context.Service<ManagedOutputs, ManagedOutputWriter>()(
  "@arden-hq/server/tools/ManagedOutputs"
) {
  static layer(root: string): Layer.Layer<ManagedOutputs, never, ManagedOutputLifecycleStore> {
    return Layer.effect(
      ManagedOutputs,
      Effect.gen(function* () {
        const lifecycle = yield* ManagedOutputLifecycleStore
        return makeManagedOutputWriter(root, lifecycle)
      })
    )
  }
}
