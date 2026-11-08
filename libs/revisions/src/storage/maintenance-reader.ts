import { Effect } from "effect"

import { decodeCanonicalJsonl, parseCommitObject, parseTreeRecord } from "../domain/codec.js"
import { Commit, ResourceVersion } from "../domain/model.js"
import { CorruptRepositoryError } from "../domain/errors.js"
import { type TreeRecord } from "../domain/format.js"
import { validateSnapshotTransition } from "../domain/integrity.js"
import { materializeSnapshot } from "../domain/tree.js"
import type { MaintenanceError, MaintenanceStorage } from "./maintenance.js"
import { sha256Hex } from "@arden-hq/std/hash"

export const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value)

export const corrupt = (message: string): Effect.Effect<never, CorruptRepositoryError> =>
  Effect.fail(new CorruptRepositoryError({ message }))

export interface MaintenanceReader {
  readonly commit: (id: string) => Effect.Effect<Commit, MaintenanceError>
  readonly tree: (id: string) => Effect.Effect<TreeRecord, MaintenanceError>
  readonly materialize: (
    id: string
  ) => Effect.Effect<ReadonlyMap<string, ResourceVersion>, MaintenanceError>
  readonly treeClosure: (id: string) => Effect.Effect<ReadonlySet<string>, MaintenanceError>
  readonly transition: (
    commit: Commit
  ) => Effect.Effect<ReadonlyMap<string, ResourceVersion>, MaintenanceError>
  readonly verifyBlob: (id: string) => Effect.Effect<void, MaintenanceError>
}

export const makeReader = (storage: MaintenanceStorage): MaintenanceReader => {
  const commits = new Map<string, Commit>()
  const trees = new Map<string, TreeRecord>()
  const snapshots = new Map<
    string,
    Effect.Effect<ReadonlyMap<string, ResourceVersion>, MaintenanceError>
  >()
  const blobs = new Set<string>()

  const commit = Effect.fn("maintenance.readCommit")(function* (
    id: string
  ): Effect.fn.Return<Commit, MaintenanceError> {
    if (!validHash(id)) return yield* corrupt(`commit identifier is invalid: ${id}`)
    const cached = commits.get(id)
    if (cached !== undefined) return cached
    const bytes = yield* storage.readObject("commit", id)
    const parsed = yield* parseCommitObject(id, bytes)
    commits.set(id, parsed)
    return parsed
  })

  const tree = Effect.fn("maintenance.readTree")(function* (
    id: string
  ): Effect.fn.Return<TreeRecord, MaintenanceError> {
    if (!validHash(id)) return yield* corrupt(`tree identifier is invalid: ${id}`)
    const cached = trees.get(id)
    if (cached !== undefined) return cached
    const bytes = yield* storage.readObject("tree", id)
    const record = yield* decodeCanonicalJsonl(bytes)
    const parsed = yield* parseTreeRecord(record)
    trees.set(id, parsed)
    return parsed
  })

  const materialize = (
    id: string
  ): Effect.Effect<ReadonlyMap<string, ResourceVersion>, MaintenanceError> =>
    materializeSnapshot(tree, id, snapshots)

  const treeClosure = Effect.fn("maintenance.treeClosure")(function* (
    id: string
  ): Effect.fn.Return<ReadonlySet<string>, MaintenanceError> {
    const result = new Set<string>()
    const active = new Set<string>()
    const visit = Effect.fn("maintenance.treeClosure.visit")(function* (
      treeId: string
    ): Effect.fn.Return<void, MaintenanceError> {
      if (active.has(treeId)) return yield* corrupt(`tree ${id} contains a cycle at ${treeId}`)
      if (result.has(treeId)) return
      active.add(treeId)
      const node = yield* tree(treeId)
      result.add(treeId)
      for (const entry of node.entries) {
        if (entry.kind === "subtree") yield* visit(entry.tree_id)
      }
      active.delete(treeId)
    })
    yield* visit(id)
    return result
  })

  const verifyBlob = Effect.fn("maintenance.verifyBlob")(function* (
    id: string
  ): Effect.fn.Return<void, MaintenanceError> {
    if (!validHash(id)) return yield* corrupt(`blob identifier is invalid: ${id}`)
    if (blobs.has(id)) return
    const bytes = yield* storage.readObject("blob", id)
    if (sha256Hex(bytes) !== id) return yield* corrupt(`blob hash mismatch: ${id}`)
    blobs.add(id)
  })

  const transition = Effect.fn("maintenance.transition")(function* (
    current: Commit
  ): Effect.fn.Return<ReadonlyMap<string, ResourceVersion>, MaintenanceError> {
    const after = yield* materialize(current.treeId)
    const before =
      current.parentId === null
        ? new Map<string, ResourceVersion>()
        : yield* materialize((yield* commit(current.parentId)).treeId)
    yield* validateSnapshotTransition(current, before, after)
    for (const resource of after.values()) yield* verifyBlob(resource.blobId)
    return after
  })

  return { commit, tree, materialize, treeClosure, transition, verifyBlob }
}
