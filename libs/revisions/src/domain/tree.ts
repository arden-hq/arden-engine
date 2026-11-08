import { Effect } from "effect"

import type { ResourceSnapshot } from "./change-set.js"
import { ResourceVersion } from "./model.js"
import { CorruptRepositoryError } from "./errors.js"
import { type TreeRecord } from "./format.js"
import { validateActivePaths } from "./integrity.js"
import { compareCodePoints } from "@arden-hq/std/json"

const failCorrupt = (message: string): Effect.Effect<never, CorruptRepositoryError> =>
  Effect.fail(new CorruptRepositoryError({ message }))

export const materializeSnapshot = Effect.fn("Revision.materializeSnapshot")(function* <E>(
  readTree: (id: string) => Effect.Effect<TreeRecord, E>,
  treeId: string,
  cache?: Map<string, Effect.Effect<ResourceSnapshot, E | CorruptRepositoryError>>
): Effect.fn.Return<ResourceSnapshot, E | CorruptRepositoryError> {
  const active = new Set<string>()
  const visit = function* (
    id: string,
    prefix: string,
    depth: number
  ): Generator<Effect.Effect<unknown, E | CorruptRepositoryError>, ResourceSnapshot, unknown> {
    if (depth > 64) return yield* failCorrupt(`tree ${treeId} exceeds the maximum directory depth`)
    if (active.has(id)) return yield* failCorrupt(`tree ${treeId} contains a cycle at ${id}`)
    const key = `${prefix}\0${id}`
    const existing = cache?.get(key)
    if (existing !== undefined) return yield* existing
    const read = Effect.gen(function* () {
      active.add(id)
      const tree = yield* readTree(id)
      const resources = new Map<string, ResourceVersion>()
      const activePaths = new Set<string>()
      for (const entry of tree.entries) {
        const versions =
          entry.kind === "subtree"
            ? (yield* visit(entry.tree_id, `${prefix}${entry.name}/`, depth + 1)).values()
            : [
                new ResourceVersion(
                  {
                    resourceId: entry.resource_id,
                    path: `${prefix}${entry.name}`,
                    blobId: entry.blob_id,
                    state: entry.state,
                    versionId: entry.version_id
                  },
                  { disableChecks: true }
                )
              ]
        for (const version of versions) {
          if (version.state === "active" && activePaths.has(version.path))
            return yield* failCorrupt(`tree repeats active path ${version.path}`)
          if (version.state === "active") activePaths.add(version.path)
          if (resources.has(version.resourceId))
            return yield* failCorrupt(`tree repeats resource ${version.resourceId}`)
          resources.set(version.resourceId, version)
        }
      }
      active.delete(id)
      return resources
    })
    if (cache === undefined) return yield* read
    const shared = yield* Effect.cached(read)
    cache.set(key, shared)
    return yield* shared
  }
  const snapshot = yield* visit(treeId, "", 0)
  yield* validateActivePaths(snapshot)
  return new Map([...snapshot.entries()].sort(([left], [right]) => compareCodePoints(left, right)))
})
