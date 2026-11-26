import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"

import { posix } from "node:path"

import type { SpaceStore, SpaceStoreError } from "../persistence/spaces/store.js"
import { wikiError, type WikiError, type WikiOperation } from "./errors.js"
import { directoryReadme, nameTakenBy, type Snapshot } from "./snapshot.js"
import { activeSpaceBindings, heldByAnother, spaceOwnsPath } from "./space-index.js"

export type WikiLocationAuthority =
  | { readonly _tag: "Global" }
  | { readonly _tag: "Space"; readonly spaceId: string }

export const GLOBAL_WIKI_LOCATION_AUTHORITY: Extract<
  WikiLocationAuthority,
  { readonly _tag: "Global" }
> = { _tag: "Global" }

export interface WikiWriteBoundary {
  readonly spaceId: string
  readonly pageId: string
  readonly pagePath: string
}

export const resolveWikiWriteBoundary = Effect.fn("Wiki.resolveWriteBoundary")(function* (
  spaces: Pick<SpaceStore["Service"], "get" | "activeBindings">,
  authority: WikiLocationAuthority,
  snapshot: Snapshot,
  operation: WikiOperation
): Effect.fn.Return<WikiWriteBoundary | undefined, WikiError> {
  if (authority._tag === "Global") return undefined

  const space = yield* spaces
    .get(authority.spaceId)
    .pipe(
      Effect.mapError((cause) =>
        wikiError(operation, "storage", "Could not resolve the Space Memory boundary", { cause })
      )
    )
  if (space === null || space.page_id === null || space.page_path === null) {
    return yield* wikiError(operation, "blocked", "This Space run has no active Memory boundary")
  }

  const boundaryPage = snapshot.pages.find(
    (record) =>
      record.page.pageId === space.page_id &&
      record.resource.path.toLowerCase() === space.page_path?.toLowerCase() &&
      record.page.lifecycle === WIKI_PAGE_LIFECYCLE.active
  )
  if (boundaryPage === undefined) {
    return yield* wikiError(
      operation,
      "blocked",
      "This Space run's Memory boundary is unavailable",
      {
        pageId: space.page_id
      }
    )
  }

  const bindings = yield* activeSpaceBindings(spaces).pipe(
    Effect.mapError((cause) =>
      wikiError(operation, "storage", "Could not validate active Space Memory boundaries", {
        cause
      })
    )
  )
  const others = bindings.filter((binding) => binding.space_id !== space.space_id)
  if (heldByAnother(others, boundaryPage.page.pageId, boundaryPage.resource.path)) {
    return yield* wikiError(
      operation,
      "blocked",
      "Active Space Memory boundaries overlap or are invalid"
    )
  }

  return {
    spaceId: space.space_id,
    pageId: boundaryPage.page.pageId,
    pagePath: boundaryPage.resource.path
  }
})

export const requireWikiWritePaths = Effect.fn("Wiki.requireWritePaths")(function* (
  boundary: WikiWriteBoundary | undefined,
  operation: WikiOperation,
  paths: ReadonlyArray<string>
): Effect.fn.Return<void, WikiError> {
  if (boundary === undefined) return
  const denied = paths.find((path) => !spaceOwnsPath(boundary.pagePath, path))
  if (denied === undefined) return

  return yield* wikiError(
    operation,
    "blocked",
    `Space runs may write only within ${boundary.pagePath}`
  )
})

export const requireNewPagePlace = Effect.fn("Wiki.requireNewPagePlace")(function* (
  snapshot: Snapshot,
  boundary: WikiWriteBoundary | undefined,
  spaceOwns: (pageId: string, path: string) => Effect.Effect<boolean, SpaceStoreError>,
  path: string
): Effect.fn.Return<void, WikiError | SpaceStoreError> {
  const directory = posix.dirname(path)
  const readme = directoryReadme(snapshot.wholeSet, directory)
  if (readme === undefined)
    return yield* wikiError("create", "blocked", `Memory folder is not mapped: ${directory}`)
  const { pageId } = readme.page
  if (
    (yield* spaceOwns(pageId, readme.resource.path)) &&
    !authorityOwnsBoundaryPage(boundary, pageId, readme.resource.path)
  )
    return yield* wikiError(
      "create",
      "blocked",
      "Pages cannot be created inside a Space-owned folder"
    )
  const existing = nameTakenBy(snapshot, path)
  if (existing !== undefined)
    return yield* wikiError(
      "create",
      "conflict",
      `Memory path or link name already exists: ${path}`,
      {
        pageId: existing.page.pageId
      }
    )
})

export const authorityOwnsBoundaryPage = (
  boundary: WikiWriteBoundary | undefined,
  pageId: string,
  path: string
): boolean =>
  boundary !== undefined &&
  boundary.pageId === pageId &&
  boundary.pagePath.toLowerCase() === path.toLowerCase()
