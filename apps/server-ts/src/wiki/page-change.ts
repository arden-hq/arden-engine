import type { CommitResult, ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"

import { commitWiki } from "./commit.js"
import { requireCommitRules } from "./commit-rules.js"
import { type WikiCommitPoint, type WikiWrite, type WikiWriter } from "./commit-write-types.js"
import { type WikiCommitIdentity } from "./origin.js"
import { mapRevisionError, WikiError, wikiError, type WikiOperation } from "./errors.js"
import type { WikiListingMethods } from "./listing.js"
import { loadSnapshot, notFound, type PageRecord, type Snapshot } from "./snapshot.js"

export interface WikiChangeWriter extends WikiCommitIdentity, WikiWriter {
  readonly operation: WikiOperation
  readonly read?: {
    readonly head: string
    readonly versions: ReadonlyArray<readonly [pageId: string, version: string]>
  }
}

export interface WikiPlan<A> {
  readonly writes: ReadonlyArray<WikiWrite>
  readonly value: A
  readonly reason?: string
}

type WikiPlanner<A, E = never> = (snapshot: Snapshot) => Effect.Effect<WikiPlan<A>, WikiError | E>

export interface WikiChanges {
  readonly change: <A, E = never>(
    writer: WikiChangeWriter,
    planner: WikiPlanner<A, E>
  ) => Effect.Effect<
    { readonly value: A; readonly commit: CommitResult | undefined },
    WikiError | E
  >
  readonly preview: <A>(
    writer: WikiChangeWriter,
    planner: WikiPlanner<A>
  ) => Effect.Effect<A, WikiError>
  readonly check: (
    writer: WikiChangeWriter,
    writes: ReadonlyArray<WikiWrite>
  ) => Effect.Effect<void, WikiError>
  readonly saved: (operation: WikiOperation, pageId: string) => Effect.Effect<WikiPage, WikiError>
}

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
  if (read === undefined) return
  for (const [pageId, version] of read.versions) {
    const record = yield* pageIn(writer.operation, snapshot, pageId)
    if (record.resource.versionId !== version)
      return yield* wikiError(writer.operation, "conflict", "Memory page changed", { pageId })
  }
  if (snapshot.head !== read.head) {
    const only = read.versions.length === 1 ? read.versions[0]?.[0] : undefined
    return yield* wikiError(
      writer.operation,
      "conflict",
      "Memory page changed",
      only === undefined ? {} : { pageId: only }
    )
  }
})

const withCurrent = (repository: ManagedFileRepositoryShape, cause: WikiError) => {
  const pageId = cause.pageId
  if (cause.reason !== "conflict" || pageId === undefined) return Effect.succeed(cause)
  const told = { ...cause, message: cause.message }
  return Effect.gen(function* () {
    const currentHead = yield* repository.currentRevision
    const resource = yield* repository.get(pageId, { at: currentHead })
    if (resource === null) return new WikiError({ ...told, currentHead })
    const bytes = yield* repository.readVersion(resource)
    const currentContent = yield* Effect.try(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    )
    return new WikiError({
      ...told,
      currentHead,
      currentVersion: resource.versionId,
      currentContent
    })
  }).pipe(Effect.orElseSucceed(() => cause))
}

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
                `Memory changed during the ${writer.operation}`,
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
      read(pageId).pipe(
        Effect.mapError((cause) => new WikiError({ ...cause, message: cause.message, operation }))
      )
  }
}
