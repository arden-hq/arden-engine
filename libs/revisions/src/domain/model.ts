import { posix, win32 } from "node:path"

import { Effect, Schema } from "effect"

import { InvalidRevisionInputError, UnsafePathError } from "./errors.js"
import { canonicalJsonl } from "./format.js"
import { sha256Hex } from "@arden-hq/std/hash"

const NonEmptyText = Schema.String.check(Schema.isMinLength(1))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** The only states represented by a resource version. */
export const ResourceState = Schema.Union([Schema.Literal("active"), Schema.Literal("archived")])
export type ResourceState = typeof ResourceState.Type

/** A normalized, immutable resource version. */
export class ResourceVersion extends Schema.Class<ResourceVersion>(
  "arden/revisions/ResourceVersion"
)({
  resourceId: NonEmptyText,
  path: NonEmptyText,
  blobId: Hash,
  state: ResourceState,
  versionId: Hash
}) {}

/** Exact bytes observed for one externally changed active resource. */
export class WorkingTreeChange extends Schema.Class<WorkingTreeChange>(
  "arden/revisions/WorkingTreeChange"
)({
  resourceId: NonEmptyText,
  path: NonEmptyText,
  expectedVersion: Hash,
  content: Schema.Uint8Array
}) {}

/** A guarded request to publish already-materialized working-tree changes. */
export class WorkingTreeAdoption extends Schema.Class<WorkingTreeAdoption>(
  "arden/revisions/WorkingTreeAdoption"
)({
  expectedHead: Schema.NullOr(Hash),
  changes: Schema.Array(WorkingTreeChange).check(Schema.isMinLength(1)),
  actor: NonEmptyText,
  origin: NonEmptyText,
  reason: NonEmptyText,
  idempotencyKey: NonEmptyText
}) {}

/** A newly created resource. */
export class Create extends Schema.TaggedClass<Create>()("Create", {
  resourceId: NonEmptyText,
  path: NonEmptyText,
  content: Schema.Uint8Array
}) {}

/** A replacement guarded by an exact previous version. */
export class Update extends Schema.TaggedClass<Update>()("Update", {
  resourceId: NonEmptyText,
  expectedVersion: Hash,
  content: Schema.Uint8Array
}) {}

class Move extends Schema.TaggedClass<Move>()("Move", {
  resourceId: NonEmptyText,
  expectedVersion: Hash,
  path: NonEmptyText,
  content: Schema.optionalKey(Schema.Uint8Array)
}) {}

class Archive extends Schema.TaggedClass<Archive>()("Archive", {
  resourceId: NonEmptyText,
  expectedVersion: Hash
}) {}

/** Re-activates an archived resource, optionally changing path/content. */
export class Restore extends Schema.TaggedClass<Restore>()("Restore", {
  resourceId: NonEmptyText,
  expectedVersion: Hash,
  path: Schema.optionalKey(NonEmptyText),
  content: Schema.optionalKey(Schema.Uint8Array)
}) {}

export const Operation = Schema.Union([Create, Update, Move, Archive, Restore])
export type Operation = typeof Operation.Type

/** A validated immutable request submitted to the repository boundary. */
export class ChangeSet extends Schema.Class<ChangeSet>("arden/revisions/ChangeSet")({
  operations: Schema.Array(Operation).check(Schema.isMinLength(1)),
  actor: NonEmptyText,
  origin: NonEmptyText,
  reason: NonEmptyText,
  idempotencyKey: NonEmptyText,
  expectedHead: Schema.optionalKey(Schema.NullOr(Hash)),
  enforceExpectedHead: Schema.optionalKey(Schema.Boolean)
}) {}

export class ResourceChange extends Schema.Class<ResourceChange>("arden/revisions/ResourceChange")({
  action: NonEmptyText,
  before: Schema.NullOr(ResourceVersion),
  after: Schema.NullOr(ResourceVersion)
}) {}

/** A parsed immutable commit. Timestamp is kept as canonical text to retain microseconds. */
export class Commit extends Schema.Class<Commit>("arden/revisions/Commit")({
  commitId: Hash,
  parentId: Schema.NullOr(Hash),
  treeId: Hash,
  actor: NonEmptyText,
  origin: NonEmptyText,
  reason: NonEmptyText,
  timestamp: NonEmptyText,
  changes: Schema.Array(ResourceChange).check(Schema.isMinLength(1))
}) {}

/** Validate and return an already-normalized POSIX-relative managed path. */
export const normalizeRelativePath = Effect.fn("normalizeRelativePath")(function* (
  value: string
): Effect.fn.Return<string, UnsafePathError> {
  const normalized = posix.normalize(value)
  const parts = value.split(posix.sep)
  const invalid =
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    normalized !== value ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  if (invalid) {
    return yield* new UnsafePathError({
      message: `managed path must be normalized and relative: ${value}`
    })
  }
  return normalized
})

/** Build the canonical version token from an immutable resource identity. */
export const makeVersion = Effect.fn("makeVersion")(function* (
  resourceId: string,
  path: string,
  blobId: string,
  state: ResourceState,
  previousVersionId: string | null = null
): Effect.fn.Return<ResourceVersion, UnsafePathError | InvalidRevisionInputError> {
  const normalizedPath = yield* normalizeRelativePath(path)
  const validResourceId = yield* Schema.decodeUnknownEffect(NonEmptyText)(resourceId).pipe(
    Effect.mapError(
      () => new InvalidRevisionInputError({ message: "resourceId must not be empty" })
    )
  )
  const validBlobId = yield* Schema.decodeUnknownEffect(Hash)(blobId).pipe(
    Effect.mapError(
      () => new InvalidRevisionInputError({ message: "blobId must be a SHA-256 identifier" })
    )
  )
  const validState = yield* Schema.decodeUnknownEffect(ResourceState)(state).pipe(
    Effect.mapError(
      () => new InvalidRevisionInputError({ message: "state must be active or archived" })
    )
  )
  const validPreviousId =
    previousVersionId === null
      ? null
      : yield* Schema.decodeUnknownEffect(Hash)(previousVersionId).pipe(
          Effect.mapError(
            () =>
              new InvalidRevisionInputError({
                message: "previousVersionId must be a SHA-256 identifier"
              })
          )
        )
  const identity = {
    blob_id: validBlobId,
    path: normalizedPath,
    previous_version_id: validPreviousId,
    resource_id: validResourceId,
    state: validState
  } as const
  return new ResourceVersion({
    resourceId: validResourceId,
    path: normalizedPath,
    blobId: validBlobId,
    state: validState,
    versionId: sha256Hex(canonicalJsonl(identity))
  })
})
