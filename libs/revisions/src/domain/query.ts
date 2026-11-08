import { structuredPatch } from "diff"
import { Effect } from "effect"

import type { ResourceSnapshot } from "./change-set.js"
import { ResourceVersion } from "./model.js"
import {
  CorruptRepositoryError,
  InvalidRevisionInputError,
  RevisionContentLimitError
} from "./errors.js"
import type { RevisionError } from "./errors.js"
import { compareCodePoints } from "@arden-hq/std/json"

export interface ResourceDiff {
  readonly resourceId: string
  readonly before: ResourceVersion | null
  readonly after: ResourceVersion | null
  readonly unifiedDiff: string
}

export interface ResourceDiffPage {
  readonly resourceId: string
  readonly before: ResourceVersion | null
  readonly after: ResourceVersion | null
  readonly offset: number
  readonly endOffset: number
  readonly hasMore: boolean
  readonly unifiedDiff: string
}

export interface UnifiedDiffPage {
  readonly offset: number
  readonly endOffset: number
  readonly hasMore: boolean
  readonly text: string
}

export type BlobReader = (blobId: string) => Effect.Effect<Uint8Array, RevisionError>
export type BlobSizer = (blobId: string) => Effect.Effect<number, RevisionError>

const failInput = (message: string): Effect.Effect<never, InvalidRevisionInputError> =>
  Effect.fail(new InvalidRevisionInputError({ message }))

const resourceVersionEqual = (
  left: ResourceVersion | null,
  right: ResourceVersion | null
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.resourceId === right.resourceId &&
    left.path === right.path &&
    left.blobId === right.blobId &&
    left.state === right.state &&
    left.versionId === right.versionId)

const diffDecoder = new TextDecoder("utf-8")

const unifiedRange = (start: number, count: number): string => {
  if (count === 0) return `${start - 1},0`
  if (count === 1) return `${start}`
  return `${start},${count}`
}

const unifiedDiffChunks = (
  before: Uint8Array,
  after: Uint8Array,
  oldLabel: string,
  newLabel: string
): readonly string[] => {
  const patch = structuredPatch(
    oldLabel,
    newLabel,
    diffDecoder.decode(before),
    diffDecoder.decode(after),
    undefined,
    undefined,
    { context: 3 }
  )
  if (patch.hunks.length === 0) return []

  const chunks: string[] = [`--- ${oldLabel}\n`, `+++ ${newLabel}\n`]
  for (const hunk of patch.hunks) {
    chunks.push(
      `@@ -${unifiedRange(hunk.oldStart, hunk.oldLines)} +${unifiedRange(hunk.newStart, hunk.newLines)} @@\n`
    )
    for (const line of hunk.lines) chunks.push(`${line}\n`)
  }
  return chunks
}

const unifiedDiff = (
  before: Uint8Array,
  after: Uint8Array,
  oldLabel: string,
  newLabel: string
): string => unifiedDiffChunks(before, after, oldLabel, newLabel).join("")

const codePoints = (value: string): readonly string[] => Array.from(value)

const renderPage = Effect.fn("renderPage")(function* (
  chunks: readonly string[],
  offset: number,
  limit: number,
  tail: boolean
): Effect.fn.Return<UnifiedDiffPage, InvalidRevisionInputError> {
  const points = codePoints(chunks.join(""))
  if (tail) {
    const pageOffset = points.length === 0 ? 0 : Math.floor((points.length - 1) / limit) * limit
    return {
      offset: pageOffset,
      endOffset: points.length,
      hasMore: false,
      text: points.slice(pageOffset).join("")
    }
  }
  if (offset > points.length || (offset === points.length && offset > 0)) {
    return yield* failInput("offset is outside the resource diff")
  }
  const endOffset = Math.min(points.length, offset + limit)
  return {
    offset,
    endOffset,
    hasMore: endOffset < points.length,
    text: points.slice(offset, endOffset).join("")
  }
})

const validatePageArguments = Effect.fn("validatePageArguments")(function* (
  resourceId: string,
  offset: number,
  limit: number,
  tail: boolean
): Effect.fn.Return<void, InvalidRevisionInputError> {
  if (typeof resourceId !== "string" || resourceId.length === 0)
    return yield* failInput("resource_id must be a nonempty string")
  if (!Number.isInteger(offset) || offset < 0)
    return yield* failInput("offset must be a nonnegative integer")
  if (!Number.isInteger(limit) || limit <= 0)
    return yield* failInput("limit must be a positive integer")
  if (typeof tail !== "boolean") return yield* failInput("tail must be a bool")
  if (tail && offset !== 0) return yield* failInput("offset must be zero when tail is requested")
})

const unifiedDiffPage = Effect.fn("unifiedDiffPage")(function* (
  before: Uint8Array,
  after: Uint8Array,
  oldLabel: string,
  newLabel: string,
  offset: number,
  limit: number,
  tail: boolean
): Effect.fn.Return<UnifiedDiffPage, InvalidRevisionInputError> {
  yield* validatePageArguments("diff", offset, limit, tail)
  return yield* renderPage(
    unifiedDiffChunks(before, after, oldLabel, newLabel),
    offset,
    limit,
    tail
  )
})

export const diff = Effect.fn("diff")(function* (
  before: ResourceSnapshot,
  after: ResourceSnapshot,
  resourceIds: Iterable<string> | null | undefined,
  readBlob: BlobReader
): Effect.fn.Return<readonly ResourceDiff[], RevisionError> {
  let selected: ReadonlySet<string> | null = null
  if (resourceIds !== null && resourceIds !== undefined) {
    if (typeof resourceIds === "string" || resourceIds instanceof Uint8Array) {
      return yield* failInput("resource_ids must be an iterable of resource IDs")
    }
    const values = [...resourceIds]
    if (!values.every((resourceId) => typeof resourceId === "string" && resourceId.length > 0)) {
      return yield* failInput("resource_ids must contain only nonempty strings")
    }
    selected = new Set(values)
  }

  const changedIds = new Set<string>([...before.keys(), ...after.keys()])
  const result: ResourceDiff[] = []
  for (const resourceId of [...changedIds].sort(compareCodePoints)) {
    if (selected !== null && !selected.has(resourceId)) continue
    const old = before.get(resourceId) ?? null
    const next = after.get(resourceId) ?? null
    if (resourceVersionEqual(old, next)) continue
    const oldContent = old === null ? new Uint8Array() : yield* readBlob(old.blobId)
    const newContent = next === null ? new Uint8Array() : yield* readBlob(next.blobId)
    result.push({
      resourceId,
      before: old,
      after: next,
      unifiedDiff: unifiedDiff(
        oldContent,
        newContent,
        old?.path ?? "/dev/null",
        next?.path ?? "/dev/null"
      )
    })
  }
  return result
})

export const diffPage = Effect.fn("diffPage")(function* (
  before: ResourceVersion | null,
  after: ResourceVersion | null,
  resourceId: string,
  offset: number,
  limit: number,
  tail: boolean,
  readBlob: BlobReader
): Effect.fn.Return<ResourceDiffPage, RevisionError> {
  yield* validatePageArguments(resourceId, offset, limit, tail)
  if (resourceVersionEqual(before, after))
    return yield* failInput(`resource did not change between revisions: ${resourceId}`)
  const oldContent = before === null ? new Uint8Array() : yield* readBlob(before.blobId)
  const newContent = after === null ? new Uint8Array() : yield* readBlob(after.blobId)
  const page = yield* unifiedDiffPage(
    oldContent,
    newContent,
    before?.path ?? "/dev/null",
    after?.path ?? "/dev/null",
    offset,
    limit,
    tail
  )
  return {
    resourceId,
    before,
    after,
    offset: page.offset,
    endOffset: page.endOffset,
    hasMore: page.hasMore,
    unifiedDiff: page.text
  }
})

export const diffVersionsPage = Effect.fn("diffVersionsPage")(function* (
  before: ResourceVersion | null,
  after: ResourceVersion | null,
  offset: number,
  limit: number,
  tail: boolean,
  sourceByteLimit: number | null | undefined,
  blobSize: BlobSizer,
  readBlob: BlobReader
): Effect.fn.Return<ResourceDiffPage, RevisionError> {
  if (before !== null && !(before instanceof ResourceVersion))
    return yield* failInput("before must be a ResourceVersion or None")
  if (after !== null && !(after instanceof ResourceVersion))
    return yield* failInput("after must be a ResourceVersion or None")
  if (before !== null && after !== null && before.resourceId !== after.resourceId) {
    return yield* failInput("resource versions must have the same resource ID")
  }
  const resource = after ?? before
  if (resource === null) return yield* failInput("a resource diff requires before or after")
  if (resourceVersionEqual(before, after)) {
    return yield* failInput(`resource did not change between versions: ${resource.resourceId}`)
  }
  yield* validatePageArguments(resource.resourceId, offset, limit, tail)
  if (
    sourceByteLimit !== null &&
    sourceByteLimit !== undefined &&
    (!Number.isInteger(sourceByteLimit) || sourceByteLimit <= 0)
  )
    return yield* failInput("source_byte_limit must be a positive integer or None")

  const versions = [before, after].filter((version): version is ResourceVersion => version !== null)
  const unique = new Map<string, ResourceVersion>()
  for (const version of versions) unique.set(version.blobId, version)
  let actualBytes = 0
  for (const version of unique.values()) actualBytes += yield* blobSize(version.blobId)
  if (sourceByteLimit !== null && sourceByteLimit !== undefined && actualBytes > sourceByteLimit) {
    return yield* new RevisionContentLimitError({
      actualBytes,
      limitBytes: sourceByteLimit,
      message: `resource diff source content exceeds ${sourceByteLimit} bytes`
    })
  }

  const contents = new Map<string, Uint8Array>()
  for (const version of unique.values())
    contents.set(version.blobId, yield* readBlob(version.blobId))
  const readExactBlob: BlobReader = (blobId) => {
    const content = contents.get(blobId)
    return content === undefined
      ? Effect.fail(new CorruptRepositoryError({ message: `source blob is missing: ${blobId}` }))
      : Effect.succeed(content)
  }
  return yield* diffPage(before, after, resource.resourceId, offset, limit, tail, readExactBlob)
})
