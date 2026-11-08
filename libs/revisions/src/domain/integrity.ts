import { Effect } from "effect"

import type { ResourceSnapshot } from "./change-set.js"
import { Commit, ResourceVersion, makeVersion } from "./model.js"
import { CorruptRepositoryError } from "./errors.js"
import { compareCodePoints } from "@arden-hq/std/json"

const failCorrupt = (message: string): Effect.Effect<never, CorruptRepositoryError> =>
  Effect.fail(new CorruptRepositoryError({ message }))

const versionsEqual = (left: ResourceVersion | null, right: ResourceVersion | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.resourceId === right.resourceId &&
    left.path === right.path &&
    left.blobId === right.blobId &&
    left.state === right.state &&
    left.versionId === right.versionId)

const changeResourceId = (change: {
  readonly before: ResourceVersion | null
  readonly after: ResourceVersion | null
}): string | null => change.after?.resourceId ?? change.before?.resourceId ?? null

const validChangeAction = (change: {
  readonly action: string
  readonly before: ResourceVersion | null
  readonly after: ResourceVersion | null
}): boolean => {
  const { before, after } = change
  if (change.action === "create") return before === null && after !== null
  if (
    before === null ||
    after === null ||
    before.resourceId !== after.resourceId ||
    versionsEqual(before, after)
  )
    return false
  if (change.action === "update") {
    return (
      before.state === "active" &&
      after.state === "active" &&
      before.path === after.path &&
      before.blobId !== after.blobId
    )
  }
  if (change.action === "move") {
    return (
      before.state === "active" &&
      after.state === "active" &&
      (before.path !== after.path || before.blobId !== after.blobId)
    )
  }
  if (change.action === "archive") {
    return (
      before.state === "active" &&
      after.state === "archived" &&
      before.path === after.path &&
      before.blobId === after.blobId
    )
  }
  if (change.action === "restore") return after.state === "active"
  return false
}

export const validateSnapshotTransition = Effect.fn("Revision.validateSnapshotTransition")(
  function* (
    commit: Commit,
    before: ResourceSnapshot,
    after: ResourceSnapshot
  ): Effect.fn.Return<void, CorruptRepositoryError> {
    const identified = commit.changes.flatMap((change) => {
      const resourceId = changeResourceId(change)
      return resourceId === null ? [] : [[resourceId, change] as const]
    })
    if (identified.length !== commit.changes.length)
      return yield* failCorrupt(
        `commit ${commit.commitId} contains a change without a resource identity`
      )
    const recordedIds = identified.map(([resourceId]) => resourceId)
    const changedIds: string[] = []
    for (const [resourceId, version] of before) {
      if (!versionsEqual(version, after.get(resourceId) ?? null)) changedIds.push(resourceId)
    }
    for (const resourceId of after.keys()) {
      if (!before.has(resourceId)) changedIds.push(resourceId)
    }
    changedIds.sort(compareCodePoints)
    if (
      recordedIds.length !== changedIds.length ||
      recordedIds.some((resourceId, index) => resourceId !== changedIds[index])
    )
      return yield* failCorrupt(
        `commit ${commit.commitId} changes do not match its parent and resulting trees`
      )
    const changed = new Map(identified)
    if (changed.size !== commit.changes.length)
      return yield* failCorrupt(`commit ${commit.commitId} repeats a resource change`)
    for (const resourceId of changedIds) {
      const beforeVersion = before.get(resourceId) ?? null
      const afterVersion = after.get(resourceId) ?? null
      const change = changed.get(resourceId)
      if (
        change === undefined ||
        change.after === null ||
        !versionsEqual(beforeVersion, change.before) ||
        !versionsEqual(afterVersion, change.after)
      ) {
        return yield* failCorrupt(
          `commit ${commit.commitId} does not describe its full tree transition`
        )
      }
      const recomputed = yield* makeVersion(
        change.after.resourceId,
        change.after.path,
        change.after.blobId,
        change.after.state,
        beforeVersion?.versionId ?? null
      ).pipe(
        Effect.mapError(
          () =>
            new CorruptRepositoryError({
              message: `commit ${commit.commitId} contains an invalid version identity`
            })
        )
      )
      if (recomputed.versionId !== change.after.versionId)
        return yield* failCorrupt(
          `commit ${commit.commitId} contains a non-canonical version identity`
        )
      if (!validChangeAction(change))
        return yield* failCorrupt(
          `commit ${commit.commitId} has invalid ${change.action} semantics for ${resourceId}`
        )
    }
    yield* validateActivePaths(after)
  }
)

export const validateActivePaths = Effect.fn("Revision.validateActivePaths")(function* (
  snapshot: ResourceSnapshot
): Effect.fn.Return<void, CorruptRepositoryError> {
  const activePaths = new Set(
    [...snapshot.values()]
      .filter((version) => version.state === "active")
      .map((version) => version.path)
  )
  for (const path of activePaths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (activePaths.has(path.slice(0, slash)))
        return yield* failCorrupt("tree contains an active path ancestor collision")
    }
  }
})
