import { Effect } from "effect"

import type { SpaceStore } from "../persistence/spaces/store.js"
import { wikiError, type WikiError, type WikiOperation } from "./errors.js"
import type { Snapshot } from "./snapshot.js"
import { activeSpaceBindings, heldByAnother, spaceOwnsPath } from "./space-index.js"

export type WikiLocationAuthority =
  | { readonly _tag: "Global" }
  | { readonly _tag: "Space"; readonly spaceId: string }

export const GLOBAL_WIKI_LOCATION_AUTHORITY = {
  _tag: "Global"
} as const satisfies WikiLocationAuthority

export interface WikiWriteBoundary {
  readonly spaceId: string
  readonly pageId: string
  readonly pagePath: string
}

export const resolveWikiWriteBoundary = Effect.fn("Wiki.resolveWriteBoundary")(function* (
  spaces: SpaceStore["Service"],
  authority: WikiLocationAuthority,
  snapshot: Snapshot,
  operation: WikiOperation
): Effect.fn.Return<WikiWriteBoundary | undefined, WikiError> {
  if (authority._tag === "Global") return undefined

  const space = yield* spaces
    .get(authority.spaceId)
    .pipe(
      Effect.mapError((cause) =>
        wikiError(operation, "storage", "Could not resolve the Space Wiki boundary", { cause })
      )
    )
  if (space === null || space.page_id === null || space.page_path === null) {
    return yield* wikiError(operation, "blocked", "This Space run has no active Wiki boundary")
  }

  const boundaryPage = snapshot.pages.find(
    (record) =>
      record.page.pageId === space.page_id &&
      record.resource.path.toLowerCase() === space.page_path?.toLowerCase() &&
      record.page.lifecycle === "active"
  )
  if (boundaryPage === undefined) {
    return yield* wikiError(operation, "blocked", "This Space run's Wiki boundary is unavailable", {
      pageId: space.page_id
    })
  }

  const bindings = yield* activeSpaceBindings(spaces).pipe(
    Effect.mapError((cause) =>
      wikiError(operation, "storage", "Could not validate active Space Wiki boundaries", {
        cause
      })
    )
  )
  const others = bindings.filter((binding) => binding.space_id !== space.space_id)
  if (heldByAnother(others, boundaryPage.page.pageId, boundaryPage.resource.path)) {
    return yield* wikiError(
      operation,
      "blocked",
      "Active Space Wiki boundaries overlap or are invalid"
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

export const authorityOwnsBoundaryPage = (
  boundary: WikiWriteBoundary | undefined,
  pageId: string,
  path: string
): boolean =>
  boundary !== undefined &&
  boundary.pageId === pageId &&
  boundary.pagePath.toLowerCase() === path.toLowerCase()
