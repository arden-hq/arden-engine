import { posix, win32 } from "node:path"

import { Effect, Schema } from "effect"

import { InvalidRevisionInputError, UnsafePathError } from "./errors.js"
import { canonicalJsonl } from "./format.js"
import { sha256Hex } from "@arden-hq/std/hash"

const NonEmptyText = Schema.String.check(Schema.isMinLength(1))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const RESOURCE_STATE = { active: "active", archived: "archived" } as const
export type ResourceState = (typeof RESOURCE_STATE)[keyof typeof RESOURCE_STATE]
export const ResourceState = Schema.Literals(Object.values(RESOURCE_STATE))

export const isActive = (version: { readonly state: ResourceState }): boolean =>
  version.state === RESOURCE_STATE.active

export const CHANGE_ACTION = {
  create: "create",
  update: "update",
  move: "move",
  archive: "archive",
  restore: "restore"
} as const
export type ChangeAction = (typeof CHANGE_ACTION)[keyof typeof CHANGE_ACTION]
export const ChangeAction = Schema.Literals(Object.values(CHANGE_ACTION))

export const OPERATION_TAG = {
  Create: "Create",
  Update: "Update",
  Move: "Move",
  Archive: "Archive",
  Restore: "Restore"
} as const
type OperationTag = (typeof OPERATION_TAG)[keyof typeof OPERATION_TAG]

export const CHANGE_ACTION_OF: Readonly<Record<OperationTag, ChangeAction>> = {
  Create: CHANGE_ACTION.create,
  Update: CHANGE_ACTION.update,
  Move: CHANGE_ACTION.move,
  Archive: CHANGE_ACTION.archive,
  Restore: CHANGE_ACTION.restore
}

export const PATH_SEGMENT = { current: ".", parent: ".." } as const
type DotSegment = (typeof PATH_SEGMENT)[keyof typeof PATH_SEGMENT]
const DOT_SEGMENTS: ReadonlySet<string> = new Set<DotSegment>(Object.values(PATH_SEGMENT))
export const isDotSegment = (part: string): part is DotSegment => DOT_SEGMENTS.has(part)

export class ResourceVersion extends Schema.Class<ResourceVersion>(
  "arden/revisions/ResourceVersion"
)({
  resourceId: NonEmptyText,
  path: NonEmptyText,
  blobId: Hash,
  state: ResourceState,
  versionId: Hash
}) {}

export class Create extends Schema.TaggedClass<Create>()(OPERATION_TAG.Create, {
  resourceId: NonEmptyText,
  path: NonEmptyText,
  content: Schema.Uint8Array
}) {}

export class Update extends Schema.TaggedClass<Update>()(OPERATION_TAG.Update, {
  resourceId: NonEmptyText,
  expectedVersion: Hash,
  content: Schema.Uint8Array
}) {}

class Move extends Schema.TaggedClass<Move>()(OPERATION_TAG.Move, {
  resourceId: NonEmptyText,
  expectedVersion: Hash,
  path: NonEmptyText,
  content: Schema.optionalKey(Schema.Uint8Array)
}) {}

class Archive extends Schema.TaggedClass<Archive>()(OPERATION_TAG.Archive, {
  resourceId: NonEmptyText,
  expectedVersion: Hash
}) {}

export class Restore extends Schema.TaggedClass<Restore>()(OPERATION_TAG.Restore, {
  resourceId: NonEmptyText,
  expectedVersion: Hash,
  path: Schema.optionalKey(NonEmptyText),
  content: Schema.optionalKey(Schema.Uint8Array)
}) {}

export const Operation = Schema.Union([Create, Update, Move, Archive, Restore])
export type Operation = typeof Operation.Type

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
  action: ChangeAction,
  before: Schema.NullOr(ResourceVersion),
  after: Schema.NullOr(ResourceVersion)
}) {}

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
    parts.some((part) => part.length === 0 || isDotSegment(part))
  if (invalid) {
    return yield* new UnsafePathError({
      message: `managed path must be normalized and relative: ${value}`
    })
  }
  return normalized
})

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
