import { Effect } from "effect"

import { type ResourceSnapshot } from "../domain/change-set.js"
import { decodeCanonicalJsonl, parseCommitObject, parseTreeRecord } from "../domain/codec.js"
import { Commit } from "../domain/model.js"
import { RevisionConflictError, RevisionStorageError } from "../domain/errors.js"
import type { RevisionError } from "../domain/errors.js"
import type { TreeRecord } from "../domain/format.js"
import { validateSnapshotTransition } from "../domain/integrity.js"
import { materializeSnapshot } from "../domain/tree.js"
import type { RevisionStorageShape } from "../storage/service.js"

export type RepositoryError = RevisionError | RevisionStorageError

export interface RevisionParsedCache {
  readonly trees: Map<string, TreeRecord>
  readonly commits: Map<string, Commit>
}

export interface RevisionReadCache {
  readonly parsed: RevisionParsedCache
  readonly trees: Map<string, Effect.Effect<ResourceSnapshot, RepositoryError>>
  readonly commits: Map<string, Effect.Effect<Commit, RepositoryError>>
}

const readCached = Effect.fn("Revision.readCached")(function* <A>(
  cache: Map<string, Effect.Effect<A, RepositoryError>> | undefined,
  key: string,
  read: Effect.Effect<A, RepositoryError>
): Effect.fn.Return<A, RepositoryError> {
  if (cache === undefined) return yield* read
  const existing = cache.get(key)
  if (existing !== undefined) return yield* existing
  const shared = yield* Effect.cached(read)
  cache.set(key, shared)
  return yield* shared
})

const parseVerified = Effect.fn("Revision.parseVerified")(function* <A>(
  cache: Map<string, A> | undefined,
  id: string,
  parse: Effect.Effect<A, RepositoryError>
): Effect.fn.Return<A, RepositoryError> {
  const existing = cache?.get(id)
  if (existing !== undefined) return existing
  const value = yield* parse
  if (cache !== undefined) {
    const oldest = cache.keys().next()
    if (cache.size >= 512 && oldest.done !== true) cache.delete(oldest.value)
    cache.set(id, value)
  }
  return value
})

export const readCommit = (
  storage: RevisionStorageShape,
  id: string,
  cache?: RevisionReadCache
): Effect.Effect<Commit, RepositoryError> =>
  readCached(
    cache?.commits,
    id,
    storage
      .readCommit(id)
      .pipe(
        Effect.flatMap((bytes) =>
          parseVerified(cache?.parsed.commits, id, parseCommitObject(id, bytes))
        )
      )
  )

export const validHash = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 64 &&
  [...value].every((char) => "0123456789abcdef".includes(char))

export const timestamp = (milliseconds: number): string => {
  const value = new Date(milliseconds).toISOString()
  return `${value.slice(0, 19)}.${value.slice(20, 23)}000Z`
}

/** Materialize a complete immutable tree while checking its structural invariants. */
export const materializeTree = (
  storage: RevisionStorageShape,
  treeId: string,
  cache?: RevisionReadCache
): Effect.Effect<ResourceSnapshot, RepositoryError> =>
  materializeSnapshot(
    (id) =>
      storage
        .readTree(id)
        .pipe(
          Effect.flatMap((bytes) =>
            parseVerified(
              cache?.parsed.trees,
              id,
              decodeCanonicalJsonl(bytes).pipe(Effect.flatMap(parseTreeRecord))
            )
          )
        ),
    treeId,
    cache?.trees
  )

export const currentMap = (
  storage: RevisionStorageShape,
  head: string | null,
  cache?: RevisionReadCache
): Effect.Effect<ResourceSnapshot, RepositoryError> =>
  head === null
    ? Effect.succeed(new Map())
    : Effect.gen(function* () {
        const commit = yield* readCommit(storage, head, cache)
        return yield* materializeTree(storage, commit.treeId, cache)
      })

/** Validate a commit's complete parent/tree transition and path invariants. */
export const validateTransition = Effect.fn("Revision.validateTransition")(function* (
  storage: RevisionStorageShape,
  commit: Commit,
  cache?: RevisionReadCache
): Effect.fn.Return<void, RepositoryError> {
  const before = yield* currentMap(storage, commit.parentId, cache)
  const after = yield* materializeTree(storage, commit.treeId, cache)
  yield* validateSnapshotTransition(commit, before, after)
})

export const snapshotAt = Effect.fn("Revision.snapshotAt")(function* (
  storage: RevisionStorageShape,
  commitId: string | null,
  sharedCache?: RevisionReadCache
): Effect.fn.Return<ResourceSnapshot, RepositoryError> {
  if (commitId === null) return new Map()
  if (!validHash(commitId) || !(yield* storage.isPublished(commitId))) {
    return yield* new RevisionConflictError({ message: `commit is not reachable: ${commitId}` })
  }
  const cache = sharedCache ?? {
    trees: new Map(),
    commits: new Map(),
    parsed: { trees: new Map(), commits: new Map() }
  }
  const commit = yield* readCommit(storage, commitId, cache)
  yield* validateTransition(storage, commit, cache)
  return yield* materializeTree(storage, commit.treeId, cache)
})
