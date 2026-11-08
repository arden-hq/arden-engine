import { DateTime, Effect, Option, Schema } from "effect"

import {
  Commit,
  ResourceChange,
  ResourceState,
  ResourceVersion,
  normalizeRelativePath
} from "./model.js"
import { CorruptRepositoryError } from "./errors.js"
import { canonicalJsonl, decodeUtf8 } from "./format.js"
import type {
  CommitRecord,
  JsonRecord,
  TreeEntryRecord,
  TreeRecord,
  VersionRecord
} from "./format.js"
import { compareCodePoints } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const NonEmptyText = Schema.String.check(Schema.isMinLength(1))
const CanonicalTimestamp = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/))
)

const VersionRecordSchema = Schema.Struct({
  resource_id: NonEmptyText,
  path: NonEmptyText,
  blob_id: Hash,
  state: ResourceState,
  version_id: Hash
})

const ChangeRecordSchema = Schema.Struct({
  action: NonEmptyText,
  before: Schema.NullOr(VersionRecordSchema),
  after: Schema.NullOr(VersionRecordSchema)
})

const CommitRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("commit"),
  parent_id: Schema.NullOr(Hash),
  tree_id: Hash,
  actor: NonEmptyText,
  origin: NonEmptyText,
  reason: NonEmptyText,
  timestamp: CanonicalTimestamp,
  changes: Schema.Array(ChangeRecordSchema).check(Schema.isMinLength(1))
})

const TreeResourceRecordSchema = Schema.Struct({
  kind: Schema.Literal("resource"),
  name: NonEmptyText,
  resource_id: NonEmptyText,
  blob_id: Hash,
  state: ResourceState,
  version_id: Hash
})

const TreeSubtreeRecordSchema = Schema.Struct({
  kind: Schema.Literal("subtree"),
  name: NonEmptyText,
  tree_id: Hash
})

const TreeRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("tree"),
  entries: Schema.Array(Schema.Union([TreeResourceRecordSchema, TreeSubtreeRecordSchema]))
})

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const JsonRecordFromString = Schema.fromJsonString(JsonRecordSchema)

const fail = (message: string): Effect.Effect<never, CorruptRepositoryError> =>
  Effect.fail(new CorruptRepositoryError({ message }))

const decode = <S extends Schema.Constraint>(
  schema: S,
  input: unknown,
  label: string
): Effect.Effect<S["Type"], CorruptRepositoryError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new CorruptRepositoryError({ message: `${label} has an invalid shape` }))
  )

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

/** Decode one canonical JSONL object and reject non-canonical bytes. */
export const decodeCanonicalJsonl = Effect.fn("decodeCanonicalJsonl")(function* (
  content: Uint8Array
): Effect.fn.Return<JsonRecord, CorruptRepositoryError> {
  if (
    content.length === 0 ||
    content[content.length - 1] !== 0x0a ||
    content.filter((byte) => byte === 0x0a).length !== 1
  ) {
    return yield* fail("record is not one canonical JSONL object")
  }
  const text = yield* Effect.try({
    try: () => decodeUtf8(content),
    catch: () => new CorruptRepositoryError({ message: "record is not valid UTF-8" })
  })
  const record = yield* Schema.decodeUnknownEffect(JsonRecordFromString)(text).pipe(
    Effect.mapError(() => new CorruptRepositoryError({ message: "record is invalid JSONL" }))
  )
  const canonical = canonicalJsonl(record as JsonRecord)
  if (!bytesEqual(content, canonical)) return yield* fail("record is not canonical JSONL")
  return record as JsonRecord
})

const decodeVersion = Effect.fn("decodeVersion")(function* (
  value: unknown,
  label: string
): Effect.fn.Return<VersionRecord, CorruptRepositoryError> {
  const decoded = yield* decode(VersionRecordSchema, value, label)
  const normalizedPath = yield* normalizeRelativePath(decoded.path).pipe(
    Effect.mapError(() => new CorruptRepositoryError({ message: `${label} has an unsafe path` }))
  )
  if (normalizedPath !== decoded.path) return yield* fail(`${label} has a non-normalized path`)
  return decoded
})

const toResourceVersion = (
  value: VersionRecord,
  label: string
): Effect.Effect<ResourceVersion, CorruptRepositoryError> =>
  Effect.try({
    try: () =>
      new ResourceVersion({
        resourceId: value.resource_id,
        path: value.path,
        blobId: value.blob_id,
        state: value.state,
        versionId: value.version_id
      }),
    catch: () => new CorruptRepositoryError({ message: `${label} has an invalid resource version` })
  })

const decodeChange = Effect.fn("decodeChange")(function* (
  value: unknown,
  label: string
): Effect.fn.Return<ResourceChange, CorruptRepositoryError> {
  const decoded = yield* decode(ChangeRecordSchema, value, label)
  const before =
    decoded.before === null ? null : yield* decodeVersion(decoded.before, `${label}.before`)
  const after =
    decoded.after === null ? null : yield* decodeVersion(decoded.after, `${label}.after`)
  const beforeVersion = before === null ? null : yield* toResourceVersion(before, `${label}.before`)
  const afterVersion = after === null ? null : yield* toResourceVersion(after, `${label}.after`)
  return yield* Effect.try({
    try: () =>
      new ResourceChange({ action: decoded.action, before: beforeVersion, after: afterVersion }),
    catch: () => new CorruptRepositoryError({ message: `${label} has an invalid resource change` })
  })
})

/** Parse a v2 tree record, including strict entry shapes and state values. */
export const parseTreeRecord = Effect.fn("parseTreeRecord")(function* (
  value: unknown
): Effect.fn.Return<TreeRecord, CorruptRepositoryError> {
  const decoded = yield* decode(TreeRecordSchema, value, "tree")
  const entries: TreeEntryRecord[] = []
  const subtreeNames = new Set<string>()
  const activeResourceNames = new Set<string>()
  for (const [index, entry] of decoded.entries.entries()) {
    const normalizedName = yield* normalizeRelativePath(entry.name).pipe(
      Effect.mapError(
        () => new CorruptRepositoryError({ message: `tree entry ${index} has an invalid name` })
      )
    )
    if (normalizedName !== entry.name || entry.name.includes("/")) {
      return yield* fail(`tree entry ${index} has an invalid name`)
    }
    if (entry.kind === "resource") {
      if (entry.state === "active") {
        if (activeResourceNames.has(entry.name))
          return yield* fail(`tree repeats active name ${entry.name}`)
        activeResourceNames.add(entry.name)
      }
      entries.push(entry)
    } else {
      if (subtreeNames.has(entry.name))
        return yield* fail(`tree repeats subtree name ${entry.name}`)
      subtreeNames.add(entry.name)
      entries.push(entry)
    }
  }
  const sortKey = (entry: TreeEntryRecord): string =>
    `${entry.name}\u0000${entry.kind}\u0000${entry.kind === "resource" ? entry.resource_id : entry.tree_id}`
  let previousKey: string | undefined
  for (const entry of entries) {
    const key = sortKey(entry)
    if (previousKey !== undefined && compareCodePoints(previousKey, key) > 0) {
      return yield* fail("tree entries are not uniquely ordered")
    }
    previousKey = key
  }
  return { version: 2, kind: "tree", entries }
})

/** Parse a v2 commit record and validate canonical timestamp precision. */
export const parseCommitRecord = Effect.fn("parseCommitRecord")(function* (
  value: unknown
): Effect.fn.Return<CommitRecord, CorruptRepositoryError> {
  const decoded = yield* decode(CommitRecordSchema, value, "commit")
  if (Option.isNone(DateTime.make(decoded.timestamp)))
    return yield* fail("commit timestamp is invalid")
  const resourceIds = decoded.changes.map(
    (change) => change.after?.resource_id ?? change.before?.resource_id ?? ""
  )
  const sortedIds = [...resourceIds].sort(compareCodePoints)
  if (
    resourceIds.some((resourceId, index) => resourceId !== sortedIds[index]) ||
    new Set(resourceIds).size !== resourceIds.length
  ) {
    return yield* fail("commit changes are not uniquely ordered")
  }
  return {
    version: 2,
    kind: "commit",
    parent_id: decoded.parent_id,
    tree_id: decoded.tree_id,
    actor: decoded.actor,
    origin: decoded.origin,
    reason: decoded.reason,
    timestamp: decoded.timestamp,
    changes: decoded.changes
  }
})

/** Parse a canonical commit object and attach its content-addressed identifier. */
export const parseCommitObject = Effect.fn("parseCommitObject")(function* (
  objectId: string,
  content: Uint8Array
): Effect.fn.Return<Commit, CorruptRepositoryError> {
  const record = yield* decodeCanonicalJsonl(content)
  const commitRecordValue = yield* parseCommitRecord(record)
  if (!/^[0-9a-f]{64}$/.test(objectId)) return yield* fail("commit identifier is invalid")
  if (sha256Hex(content) !== objectId)
    return yield* fail("commit object identifier does not match content")
  const changes: ResourceChange[] = []
  for (const [index, change] of commitRecordValue.changes.entries()) {
    changes.push(yield* decodeChange(change, `commit change ${index}`))
  }
  return new Commit({
    commitId: objectId,
    parentId: commitRecordValue.parent_id,
    treeId: commitRecordValue.tree_id,
    actor: commitRecordValue.actor,
    origin: commitRecordValue.origin,
    reason: commitRecordValue.reason,
    timestamp: commitRecordValue.timestamp,
    changes
  })
})

/** Encode a validated commit record into its exact v2 canonical bytes. */
export const encodeCommitRecord = (record: CommitRecord): Uint8Array =>
  canonicalJsonl(record as unknown as JsonRecord)

/** Encode a validated tree record into its exact v2 canonical bytes. */
export const encodeTreeRecord = (record: TreeRecord): Uint8Array =>
  canonicalJsonl(record as unknown as JsonRecord)
