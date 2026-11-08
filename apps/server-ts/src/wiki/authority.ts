import { isWithin } from "@arden-hq/std/paths"
import { Effect } from "effect"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import { wikiError, type WikiError, type WikiOperation } from "./errors.js"
import type { Snapshot } from "./snapshot.js"

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

export const canonicalWikiPath = (value: string): string | undefined => {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return undefined
  const normalized = posix.normalize(value)
  if (normalized === "." || normalized.split("/")[0] === ".." || normalized !== value) {
    return undefined
  }
  return normalized
}

const wikiBoundaryRoot = (boundary: string): string => {
  if (posix.basename(boundary) === "readme.md") return posix.dirname(boundary)
  if (boundary.endsWith(".md")) return boundary.slice(0, -3)
  return boundary
}

export const wikiPathWithinSpaceBoundary = (boundaryPath: string, targetPath: string): boolean => {
  const canonicalBoundary = canonicalWikiPath(boundaryPath)
  const canonicalTarget = canonicalWikiPath(targetPath)
  if (canonicalBoundary === undefined || canonicalTarget === undefined) return false

  const boundary = canonicalBoundary.toLowerCase()
  const target = canonicalTarget.toLowerCase()
  if (target === boundary) return true

  return isWithin(`/${wikiBoundaryRoot(boundary)}`, `/${target}`)
}

export const wikiSpaceBoundariesOverlap = (firstPath: string, secondPath: string): boolean =>
  wikiPathWithinSpaceBoundary(firstPath, secondPath) ||
  wikiPathWithinSpaceBoundary(secondPath, firstPath)

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

  const activeSpaces = yield* spaces.list().pipe(
    Effect.mapError((cause) =>
      wikiError(operation, "storage", "Could not validate active Space Wiki boundaries", {
        cause
      })
    )
  )
  const unsafeBinding = activeSpaces.find((candidate) => {
    if (candidate.space_id === space.space_id) return false
    if ((candidate.page_id === null) !== (candidate.page_path === null)) return true
    if (candidate.page_path === null) return false
    if (canonicalWikiPath(candidate.page_path) === undefined) return true
    return wikiSpaceBoundariesOverlap(boundaryPage.resource.path, candidate.page_path)
  })
  if (unsafeBinding !== undefined) {
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
  const denied = paths.find((path) => !wikiPathWithinSpaceBoundary(boundary.pagePath, path))
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
