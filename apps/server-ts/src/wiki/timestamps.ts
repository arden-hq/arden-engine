import {
  CorruptRepositoryError,
  type Commit,
  type ManagedFileRepositoryShape,
  type RevisionError
} from "@arden-hq/revisions/effect"
import { Deferred, Effect, Exit } from "effect"

export interface PageTimes {
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

type TimestampRepository = Pick<ManagedFileRepositoryShape, "inspectCommit">
type CompleteTimestampMap = ReadonlyMap<string, PageTimes>

interface DerivedTimes {
  readonly head: string
  readonly times: CompleteTimestampMap
}

const deriveTimestamps = Effect.fn("Wiki.deriveTimestamps")(function* (
  repository: TimestampRepository,
  head: string,
  base: DerivedTimes | undefined
): Effect.fn.Return<CompleteTimestampMap, RevisionError> {
  const mutable = new Map<string, { createdAt: string | null; updatedAt: string | null }>()
  const seen = new Set<string>()
  let cursor: string | null = head
  while (cursor !== null) {
    if (cursor === base?.head) return extendTimes(base.times, mutable)
    if (seen.has(cursor)) {
      return yield* new CorruptRepositoryError({
        message: `commit history contains a cycle at ${cursor}`
      })
    }
    seen.add(cursor)
    const commit: Commit = yield* repository.inspectCommit(cursor)
    for (const change of commit.changes) {
      const version = change.after ?? change.before
      if (version === null) continue
      const times = mutable.get(version.resourceId) ?? { createdAt: null, updatedAt: null }
      times.updatedAt ??= commit.timestamp
      if (change.action === "create") times.createdAt = commit.timestamp
      mutable.set(version.resourceId, times)
    }
    cursor = commit.parentId
  }
  return mutable
})

const extendTimes = (
  older: CompleteTimestampMap,
  newer: ReadonlyMap<string, PageTimes>
): CompleteTimestampMap => {
  const merged = new Map(older)
  for (const [pageId, times] of newer) {
    merged.set(pageId, {
      createdAt: older.get(pageId)?.createdAt ?? times.createdAt,
      updatedAt: times.updatedAt ?? older.get(pageId)?.updatedAt ?? null
    })
  }
  return merged
}

export class WikiPageTimestampCache {
  private readonly byHead = new Map<
    string,
    Deferred.Deferred<CompleteTimestampMap, RevisionError>
  >()
  private latest: DerivedTimes | undefined

  constructor(
    private readonly repository: TimestampRepository,
    private readonly maxHeads = 4
  ) {
    if (!Number.isInteger(maxHeads) || maxHeads < 1) {
      throw new RangeError("maxHeads must be a positive integer")
    }
  }

  forPages(
    head: string | null,
    pageIds: ReadonlySet<string>
  ): Effect.Effect<ReadonlyMap<string, PageTimes>, RevisionError> {
    if (head === null || pageIds.size === 0) return Effect.succeed(new Map())
    return this.forHead(head).pipe(
      Effect.map(
        (complete) =>
          new Map(
            [...pageIds].map((pageId) => [
              pageId,
              complete.get(pageId) ?? { createdAt: null, updatedAt: null }
            ])
          )
      )
    )
  }

  private forHead(head: string): Effect.Effect<CompleteTimestampMap, RevisionError> {
    return Effect.suspend(() => {
      const cached = this.byHead.get(head)
      if (cached !== undefined) {
        this.touch(head, cached)
        return Deferred.await(cached)
      }
      const pending = Deferred.makeUnsafe<CompleteTimestampMap, RevisionError>()
      this.touch(head, pending)
      return Effect.uninterruptible(
        deriveTimestamps(this.repository, head, this.latest).pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (Exit.isFailure(exit) && this.byHead.get(head) === pending)
                this.byHead.delete(head)
              if (Exit.isSuccess(exit)) this.latest = { head, times: exit.value }
              return Deferred.done(pending, exit)
            })
          )
        )
      )
    })
  }

  private touch(head: string, value: Deferred.Deferred<CompleteTimestampMap, RevisionError>): void {
    this.byHead.delete(head)
    this.byHead.set(head, value)
    while (this.byHead.size > this.maxHeads) {
      const oldest = this.byHead.keys().next().value
      if (oldest === undefined) return
      this.byHead.delete(oldest)
    }
  }
}
