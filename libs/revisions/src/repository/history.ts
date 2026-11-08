import { Effect } from "effect"

import type { Commit } from "../domain/model.js"
import { CorruptRepositoryError, InvalidRevisionInputError } from "../domain/errors.js"
import type { RevisionError } from "../domain/errors.js"

interface HistoryInput {
  readonly head: string | null
  readonly resourceId?: string | null
  readonly start?: string | null
  readonly stopBefore?: string | null
  readonly limit?: number | null
  readonly validHash: (value: unknown) => boolean
  readonly requireReachable: (commitId: string) => Effect.Effect<void, RevisionError>
  readonly loadCommit: (commitId: string) => Effect.Effect<Commit, RevisionError>
  readonly validateCommitTransition: (commit: Commit) => Effect.Effect<unknown, RevisionError>
}

interface HistoryIndex {
  readonly ids: readonly string[]
  readonly positions: ReadonlyMap<string, number>
  readonly resources: ReadonlyMap<string, readonly number[]>
}

interface HistoryWalkNode {
  readonly commit: Commit
  readonly previous: HistoryWalkNode | undefined
}

interface HistoryWalk {
  readonly start: string | null
  readonly base: HistoryIndex
  readonly cursor: string | null
  readonly tail: HistoryWalkNode | undefined
}

/** Repository-local, derived metadata. Returned revisions are always read and validated afresh. */
export const makeHistoryQuery = (): {
  readonly prepare: (
    input: Pick<HistoryInput, "head" | "loadCommit">
  ) => Effect.Effect<void, RevisionError>
  readonly query: (input: HistoryInput) => Effect.Effect<readonly Commit[], RevisionError>
} => {
  let index: HistoryIndex = { ids: [], positions: new Map(), resources: new Map() }
  let unfinished: HistoryWalk | undefined

  const prepareIndex = Effect.fn("Revision.prepareHistoryIndex")(function* (
    input: Pick<HistoryInput, "head" | "loadCommit">,
    start: string | null
  ) {
    const previous = index
    let walk: HistoryWalk =
      unfinished?.start === start && unfinished.base === previous
        ? unfinished
        : { start, base: previous, cursor: start, tail: undefined }
    unfinished = walk
    const seen = new Set<string>()
    for (let node = walk.tail; node !== undefined; node = node.previous)
      seen.add(node.commit.commitId)
    while (walk.cursor !== null && !previous.positions.has(walk.cursor)) {
      if (seen.has(walk.cursor))
        return yield* new CorruptRepositoryError({
          message: `commit history contains a cycle at ${walk.cursor}`
        })
      const commit = yield* input.loadCommit(walk.cursor)
      seen.add(walk.cursor)
      const next: HistoryWalk = {
        start,
        base: previous,
        cursor: commit.parentId,
        tail: { commit, previous: walk.tail }
      }
      if (unfinished === walk) unfinished = next
      walk = next
    }
    if (walk.tail !== undefined) {
      const cursorPosition = walk.cursor === null ? undefined : previous.positions.get(walk.cursor)
      const prefixLength = cursorPosition === undefined ? 0 : cursorPosition + 1
      const ids = previous.ids.slice(0, prefixLength)
      const positions = new Map(ids.map((id, position) => [id, position]))
      const resources = new Map<string, number[]>()
      for (const [resourceId, entries] of previous.resources) {
        const retained = entries.filter((position) => position < prefixLength)
        if (retained.length > 0) resources.set(resourceId, retained)
      }
      for (
        let node: HistoryWalkNode | undefined = walk.tail;
        node !== undefined;
        node = node.previous
      ) {
        const commit = node.commit
        const position = ids.length
        ids.push(commit.commitId)
        positions.set(commit.commitId, position)
        const changed = new Set<string>()
        for (const change of commit.changes) {
          const resource = change.after ?? change.before
          if (resource === null)
            return yield* new CorruptRepositoryError({ message: "resource change has no identity" })
          changed.add(resource.resourceId)
        }
        for (const resourceId of changed) {
          const entries = resources.get(resourceId) ?? []
          entries.push(position)
          resources.set(resourceId, entries)
        }
      }
      const completed = { ids, positions, resources }
      if (index === previous) index = completed
      if (unfinished === walk) unfinished = undefined
      return completed
    }
    if (unfinished === walk) unfinished = undefined
    return previous
  })

  const query = Effect.fn("Revision.history")(function* (input: HistoryInput) {
    if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1)) {
      return yield* new InvalidRevisionInputError({ message: "history limit must be positive" })
    }
    if (input.stopBefore != null && !input.validHash(input.stopBefore)) {
      return yield* new InvalidRevisionInputError({
        message: `unknown history stop boundary: ${input.stopBefore}`
      })
    }
    const start = input.start ?? input.head
    if (input.start != null) yield* input.requireReachable(input.start)
    if (start === input.stopBefore) return []

    if (input.resourceId == null) {
      const commits: Commit[] = []
      const seen = new Set<string>()
      let cursor = start
      while (cursor !== null) {
        if (cursor === input.stopBefore) return commits
        if (seen.has(cursor))
          return yield* new CorruptRepositoryError({
            message: `commit history contains a cycle at ${cursor}`
          })
        seen.add(cursor)
        const commit = yield* input.loadCommit(cursor)
        yield* input.validateCommitTransition(commit)
        commits.push(commit)
        if (input.stopBefore == null && input.limit != null && commits.length >= input.limit)
          return commits
        cursor = commit.parentId
      }
      if (input.stopBefore != null)
        return yield* new InvalidRevisionInputError({
          message: `history stop boundary is not reachable from the selected start: ${input.stopBefore}`
        })
      return commits
    }

    const selected = yield* prepareIndex(input, start)
    const startPosition = start === null ? -1 : selected.positions.get(start)
    if (startPosition === undefined) {
      return yield* new CorruptRepositoryError({
        message: `commit history does not index its start ${start}`
      })
    }
    const stopPosition = input.stopBefore == null ? -1 : selected.positions.get(input.stopBefore)
    if (stopPosition === undefined || stopPosition > startPosition) {
      return yield* new InvalidRevisionInputError({
        message: `history stop boundary is not reachable from the selected start: ${input.stopBefore}`
      })
    }
    const positions = selected.resources.get(input.resourceId) ?? []
    const ids: string[] = []
    for (const position of [...positions].reverse()) {
      if (position > startPosition) continue
      if (position <= stopPosition) break
      const id = selected.ids[position]
      if (id === undefined)
        return yield* new CorruptRepositoryError({
          message: `commit history has no commit at ${position}`
        })
      ids.push(id)
      if (input.stopBefore == null && input.limit != null && ids.length >= input.limit) break
    }
    return yield* Effect.forEach(
      ids,
      Effect.fn("Revision.history.id")(function* (id) {
        const commit = yield* input.loadCommit(id)
        yield* input.validateCommitTransition(commit)
        return commit
      }),
      { concurrency: 8 }
    )
  })
  return {
    query,
    prepare: (input) => prepareIndex(input, input.head).pipe(Effect.asVoid)
  }
}
