import type { CommitResult, ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"

import {
  commitWiki,
  requireCommitRules,
  type WikiCommitIdentity,
  type WikiCommitPoint,
  type WikiWrite,
  type WikiWriter
} from "./commit.js"
import { mapRevisionError, WikiError, wikiError, type WikiOperation } from "./errors.js"
import type { WikiListingMethods } from "./listing.js"
import { loadSnapshot, notFound, type PageRecord, type Snapshot } from "./snapshot.js"

/** Who changes Memory, as which operation, and what they read first. */
export interface WikiChangeWriter extends WikiCommitIdentity, WikiWriter {
  readonly operation: WikiOperation
  /** The head and page versions the writer read. A change to any of them refuses the change, and
   *  the commit is guarded by that head. Without it, the change is planned from and guarded by the
   *  head it loads. */
  readonly read?: {
    readonly head: string
    readonly versions: ReadonlyArray<readonly [pageId: string, version: string]>
  }
}

/** The page writes a change makes, and what it answers with. */
export interface WikiPlan<A> {
  readonly writes: ReadonlyArray<WikiWrite>
  readonly value: A
  /** Why, when this plan's writes are saved for another reason than the writer gave. */
  readonly reason?: string
}

type WikiPlanner<A, E = never> = (snapshot: Snapshot) => Effect.Effect<WikiPlan<A>, WikiError | E>

export interface WikiChanges {
  /** Plans from the current pages and saves the plan's writes as one commit; no writes, no commit. */
  readonly change: <A, E = never>(
    writer: WikiChangeWriter,
    planner: WikiPlanner<A, E>
  ) => Effect.Effect<
    { readonly value: A; readonly commit: CommitResult | undefined },
    WikiError | E
  >
  /** Plans from the current pages and refuses the plan by every rule its commit would meet, saving nothing. */
  readonly preview: <A>(
    writer: WikiChangeWriter,
    planner: WikiPlanner<A>
  ) => Effect.Effect<A, WikiError>
  /** Refuses `writes` by every commit rule, saving nothing. */
  readonly check: (
    writer: WikiChangeWriter,
    writes: ReadonlyArray<WikiWrite>
  ) => Effect.Effect<void, WikiError>
  /** A page a change saved, as it reads now. */
  readonly saved: (operation: WikiOperation, pageId: string) => Effect.Effect<WikiPage, WikiError>
}

/** The writer behind a service verb's input; it read `head` and each of `pages` first when given. */
export const writerOf = (
  operation: WikiOperation,
  input: { readonly authority: WikiWriter["authority"]; readonly commit: WikiCommitIdentity },
  head?: string,
  pages: ReadonlyArray<{ readonly pageId: string; readonly expectedVersion: string }> = []
): WikiChangeWriter => ({
  ...input.commit,
  authority: input.authority,
  operation,
  ...(head === undefined
    ? {}
    : {
        read: { head, versions: pages.map((page) => [page.pageId, page.expectedVersion] as const) }
      })
})

export const pageIn = (
  operation: WikiOperation,
  snapshot: Snapshot,
  pageId: string
): Effect.Effect<PageRecord, WikiError> => {
  const record = snapshot.wholeSet.find((candidate) => candidate.page.pageId === pageId)
  return record === undefined ? Effect.fail(notFound(operation, pageId)) : Effect.succeed(record)
}

const requireRead = Effect.fn("Wiki.requireRead")(function* (
  writer: WikiChangeWriter,
  snapshot: Snapshot
): Effect.fn.Return<void, WikiError> {
  const { read } = writer
  // A replayable write read before its head moved may have landed already; its receipt decides.
  if (read === undefined || (writer.replayKey !== undefined && snapshot.head !== read.head)) return
  for (const [pageId, version] of read.versions) {
    const record = yield* pageIn(writer.operation, snapshot, pageId)
    if (snapshot.head !== read.head || record.resource.versionId !== version) {
      return yield* wikiError(writer.operation, "conflict", "Wiki page changed", { pageId })
    }
  }
})

/** A conflict over one page, told with how that page reads now. */
const withCurrent = (repository: ManagedFileRepositoryShape, cause: WikiError) => {
  const pageId = cause.pageId
  if (cause.reason !== "conflict" || pageId === undefined) return Effect.succeed(cause)
  return Effect.gen(function* () {
    const currentHead = yield* repository.currentRevision
    const resource = yield* repository.get(pageId, { at: currentHead })
    if (resource === null) return new WikiError({ ...cause, currentHead })
    const bytes = yield* repository.readVersion(resource)
    const currentContent = yield* Effect.try(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    )
    return new WikiError({
      ...cause,
      currentHead,
      currentVersion: resource.versionId,
      currentContent
    })
  }).pipe(Effect.orElseSucceed(() => cause))
}

/** The page a refusal names: the one page the writer read, else the one page the plan writes. */
const errorPage = (
  writer: WikiChangeWriter,
  writes: ReadonlyArray<WikiWrite>
): string | undefined => {
  const named =
    writer.read === undefined
      ? writes.map((write) => write.operation.resourceId)
      : writer.read.versions.map(([pageId]) => pageId)
  return named.length === 1 ? named[0] : undefined
}

export const makeWikiChanges = (
  point: WikiCommitPoint,
  read: WikiListingMethods["read"]
): WikiChanges => {
  const withConflictDetail = <A, E>(
    effect: Effect.Effect<A, WikiError | E>
  ): Effect.Effect<A, WikiError | E> =>
    effect.pipe(
      Effect.catch((cause): Effect.Effect<never, WikiError | E> =>
        cause instanceof WikiError
          ? withCurrent(point.repository, cause).pipe(Effect.flatMap(Effect.fail))
          : Effect.fail(cause)
      )
    )

  const plan = Effect.fn("Wiki.plan")(function* <A, E>(
    writer: WikiChangeWriter,
    planner: WikiPlanner<A, E>
  ) {
    const snapshot = yield* loadSnapshot(point.repository, writer.operation)
    yield* requireRead(writer, snapshot)
    return { snapshot, plan: yield* planner(snapshot) }
  })

  const check: WikiChanges["check"] = (writer, writes) =>
    requireCommitRules(point, writer, writes).pipe(
      Effect.mapError(mapRevisionError(writer.operation, errorPage(writer, writes)))
    )

  const change = <A, E>(writer: WikiChangeWriter, planner: WikiPlanner<A, E>) =>
    withConflictDetail(
      Effect.gen(function* () {
        const { snapshot, plan: planned } = yield* plan(writer, planner)
        const page = errorPage(writer, planned.writes)
        if (planned.writes.length === 0) {
          if (writer.read !== undefined) {
            const latest = yield* point.repository.currentRevision.pipe(
              Effect.mapError(mapRevisionError(writer.operation, page))
            )
            if (latest !== snapshot.head) {
              return yield* wikiError(
                writer.operation,
                "conflict",
                `Wiki changed during the ${writer.operation}`,
                page === undefined ? {} : { pageId: page }
              )
            }
          }
          return { value: planned.value, commit: undefined }
        }
        const commit = yield* commitWiki(
          point,
          {
            ...writer,
            ...(planned.reason === undefined ? {} : { reason: planned.reason }),
            expectedRevision: writer.read?.head ?? snapshot.head
          },
          planned.writes
        ).pipe(Effect.mapError(mapRevisionError(writer.operation, page)))
        return { value: planned.value, commit }
      })
    )

  return {
    change,
    preview: (writer, planner) =>
      withConflictDetail(
        plan(writer, planner).pipe(
          Effect.tap(({ plan: planned }) => check(writer, planned.writes)),
          Effect.map(({ plan: planned }) => planned.value)
        )
      ),
    check,
    saved: (operation, pageId) =>
      read(pageId).pipe(Effect.mapError((cause) => new WikiError({ ...cause, operation })))
  }
}
