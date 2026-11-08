import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Context, Effect, Schema } from "effect"
import type { SpaceStore } from "../persistence/spaces/store.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { decodeWikiOrigin, type WikiCommitOrigin } from "./commit.js"

export class WikiChangeSinkError extends Schema.TaggedError<WikiChangeSinkError>()(
  "WikiChangeSinkError",
  { cause: Schema.Defect() }
) {}

export interface WikiChange {
  readonly previousRevision: string | null
  readonly revision: string
  readonly paths: ReadonlyArray<string>
  readonly origin: WikiCommitOrigin
  readonly hasSpacePage: boolean
}

export class WikiChangeSink extends Context.Service<
  WikiChangeSink,
  {
    readonly cursor: (
      initialRevision: string | null
    ) => Effect.Effect<string | null, WikiChangeSinkError>
    readonly publish: (
      change: WikiChange
    ) => Effect.Effect<{ readonly queued: number } | null, WikiChangeSinkError>
  }
>()("@arden-hq/server/wiki/WikiChangeSink") {}

const storageError = (cause: unknown) =>
  wikiError("list", "storage", "Wiki change publication remains pending", { cause })

export const makeWikiPublisher = Effect.fn("Wiki.makePublisher")(function* (
  repository: ManagedFileRepositoryShape,
  sink: WikiChangeSink["Service"],
  spaces: SpaceStore["Service"]
) {
  const openingHead = yield* repository.currentRevision.pipe(
    Effect.mapError(mapRevisionError("open"))
  )
  yield* sink.cursor(openingHead).pipe(Effect.mapError(storageError))
  return Effect.fn("Wiki.publishChanges")(function* (): Effect.fn.Return<
    { readonly queued: number },
    WikiError
  > {
    const cursor = yield* sink.cursor(openingHead).pipe(Effect.mapError(storageError))
    const head = yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("list")))
    if (head === cursor) return { queued: 0 }
    const commits = yield* repository
      .history({ start: head, stopBefore: cursor })
      .pipe(Effect.mapError(mapRevisionError("list")))
    const oldest = commits.at(-1)
    if (oldest === undefined || oldest.parentId !== cursor) {
      return yield* wikiError(
        "list",
        "corrupt",
        "Wiki publication cursor is outside the current history"
      )
    }
    let queued = 0
    for (const commit of commits.slice(-32).reverse()) {
      const resources = commit.changes.flatMap((change) => [
        ...(change.before === null ? [] : [change.before]),
        ...(change.after === null ? [] : [change.after])
      ])
      const origin = decodeWikiOrigin(commit.origin)
      let hasSpacePage = origin.kind === "space_page"
      for (const resource of resources) {
        if (hasSpacePage) break
        hasSpacePage = yield* spaces
          .hasPageBinding(resource.resourceId, resource.path)
          .pipe(Effect.mapError(storageError))
      }
      const result = yield* sink
        .publish({
          previousRevision: commit.parentId,
          revision: commit.commitId,
          paths: [...new Set(resources.map((resource) => resource.path))].sort(),
          origin,
          hasSpacePage
        })
        .pipe(Effect.mapError(storageError))
      if (result === null) break
      queued += result.queued
    }
    return { queued }
  })
})
