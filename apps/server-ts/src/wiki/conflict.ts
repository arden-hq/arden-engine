import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"

import { WikiError, wikiError, type WikiOperation } from "./errors.js"
import { notFound, type PageRecord, type Snapshot } from "./snapshot.js"

export const requireCurrent = (
  operation: WikiOperation,
  snapshot: Snapshot,
  pageId: string,
  expectedVersion: string,
  expectedHead: string
): Effect.Effect<PageRecord, WikiError> => {
  const record = snapshot.pages.find((candidate) => candidate.page.pageId === pageId)
  if (record === undefined) return Effect.fail(notFound(operation, pageId))
  if (snapshot.head !== expectedHead || record.resource.versionId !== expectedVersion) {
    return Effect.fail(wikiError(operation, "conflict", "Wiki page changed", { pageId }))
  }
  return Effect.succeed(record)
}

const enrichConflict = Effect.fn("Wiki.enrichConflict")(function* (
  repository: ManagedFileRepositoryShape,
  cause: WikiError
): Effect.fn.Return<WikiError> {
  if (cause.reason !== "conflict" || cause.pageId === undefined) return cause
  const pageId = cause.pageId
  const current = yield* Effect.gen(function* () {
    const currentHead = yield* repository.currentRevision
    const resource = yield* repository.get(pageId, { at: currentHead })
    if (resource === null) return { currentHead } as const
    const bytes = yield* repository.readVersion(resource)
    const currentContent = yield* Effect.try(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    )
    return { currentHead, currentVersion: resource.versionId, currentContent } as const
  }).pipe(Effect.orElseSucceed(() => null))
  if (current === null) return cause
  return new WikiError({
    operation: cause.operation,
    reason: cause.reason,
    message: cause.message,
    pageId: cause.pageId,
    currentHead: current.currentHead,
    ...(current.currentVersion === undefined ? {} : { currentVersion: current.currentVersion }),
    ...(current.currentContent === undefined ? {} : { currentContent: current.currentContent }),
    ...(cause.cause === undefined ? {} : { cause: cause.cause })
  })
})

export const withConflictDetail = <A>(
  repository: ManagedFileRepositoryShape,
  effect: Effect.Effect<A, WikiError>
): Effect.Effect<A, WikiError> =>
  effect.pipe(
    Effect.catchTag("WikiError", (cause) =>
      enrichConflict(repository, cause).pipe(Effect.flatMap(Effect.fail))
    )
  )
