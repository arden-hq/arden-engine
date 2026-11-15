import { Effect } from "effect"
import { posix } from "node:path"

import { isStandingFactsPage } from "../memory/core-memory.js"
import type { SpaceStore } from "../persistence/spaces/store.js"
import {
  authorityOwnsBoundaryPage,
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority
} from "./authority.js"
import { wikiError, type WikiError } from "./errors.js"
import { isReadme, parseWikiPage, writtenContent } from "./page.js"
import { followRedirect, nameTakenBy, type PageRecord, type Snapshot } from "./snapshot.js"
import { isSpacePage } from "./space-index.js"

export interface WikiWriter {
  readonly pageId: string
  readonly authority: WikiLocationAuthority
}

/** The content a page update writes, once every rule for replacing this page holds. */
export const requireUpdatable = Effect.fn("Wiki.requireUpdatable")(function* (
  spaces: SpaceStore["Service"],
  snapshot: Snapshot,
  current: PageRecord,
  input: WikiWriter & { readonly content: string }
): Effect.fn.Return<string, WikiError> {
  if (current.page.lifecycle !== "active") {
    return yield* wikiError("update", "invalid", "Only active Wiki pages can be updated", {
      pageId: input.pageId
    })
  }
  const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "update")
  yield* requireWikiWritePaths(boundary, "update", [current.resource.path])
  return yield* requireReplacement("update", input)
})

/**
 * The content a restore of an earlier version writes: an update's rules, except that a merged
 * page, a redirect at its old path, may be brought back, which is how a merge is undone.
 */
export const requireRestorable = Effect.fn("Wiki.requireRestorable")(function* (
  spaces: SpaceStore["Service"],
  snapshot: Snapshot,
  current: PageRecord,
  input: WikiWriter & { readonly content: string }
): Effect.fn.Return<string, WikiError> {
  const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "restore")
  yield* requireWikiWritePaths(boundary, "restore", [current.resource.path])
  return yield* requireReplacement("restore", input)
})

const requireReplacement = Effect.fn("Wiki.requireReplacement")(function* (
  operation: "update" | "restore",
  input: WikiWriter & { readonly content: string }
): Effect.fn.Return<string, WikiError> {
  const replacement = yield* parseWikiPage(input.content, input.pageId).pipe(
    Effect.mapError((cause) =>
      wikiError(operation, "invalid", cause.message, {
        pageId: input.pageId,
        cause
      })
    )
  )
  if (replacement.lifecycle !== "active") {
    return yield* wikiError(operation, "invalid", "A page update cannot create a redirect", {
      pageId: input.pageId
    })
  }
  return yield* writtenContent(replacement).pipe(
    Effect.mapError((cause) =>
      wikiError(operation, "invalid", cause.message, { pageId: input.pageId, cause })
    )
  )
})

/** The rules for taking a page out of Memory, by archive or by merge. */
export const requireRetirable = Effect.fn("Wiki.requireRetirable")(function* (
  spaces: SpaceStore["Service"],
  operation: "archive" | "merge",
  snapshot: Snapshot,
  current: PageRecord,
  input: WikiWriter
): Effect.fn.Return<void, WikiError> {
  if (current.page.lifecycle !== "active") {
    return yield* wikiError(operation, "invalid", "Only active Wiki pages can be retired", {
      pageId: input.pageId
    })
  }
  const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, operation)
  yield* requireWikiWritePaths(boundary, operation, [current.resource.path])
  if (isReadme(current.resource.path)) {
    const directory = posix.dirname(current.resource.path)
    const prefix = `${directory}/`
    const child = snapshot.wholeSet.find(
      (record) =>
        record.page.pageId !== input.pageId &&
        record.page.lifecycle === "active" &&
        record.resource.path.startsWith(prefix)
    )
    if (child !== undefined) {
      return yield* wikiError(operation, "blocked", `Active Wiki pages remain in ${directory}`, {
        pageId: input.pageId
      })
    }
  }
})

/** The rules for archiving a page: those for retiring it, and no redirect may be left pointing
 *  nowhere. */
export const requireArchivable = Effect.fn("Wiki.requireArchivable")(function* (
  spaces: SpaceStore["Service"],
  snapshot: Snapshot,
  current: PageRecord,
  input: WikiWriter
): Effect.fn.Return<void, WikiError> {
  yield* requireRetirable(spaces, "archive", snapshot, current, input)
  const remaining = snapshot.wholeSet.filter((record) => record.page.pageId !== input.pageId)
  const remainingById = new Map(remaining.map((record) => [record.page.pageId, record] as const))
  const brokenRedirect = remaining.find(
    (record) =>
      record.page.lifecycle === "redirect" &&
      followRedirect(remainingById, record.page.pageId) === null
  )
  if (brokenRedirect !== undefined) {
    return yield* wikiError(
      "archive",
      "invalid",
      `Page is still the target of redirect ${brokenRedirect.page.pageId}`,
      { pageId: input.pageId }
    )
  }
})

export const createRefusal = (
  path: string
): { readonly code: "invalid" | "blocked"; readonly message: string } | undefined => {
  if (!path.endsWith(".md")) return { code: "invalid", message: "Wiki page paths must end in .md" }
  if ((posix.dirname(path) === "." && !isStandingFactsPage({ path, pageId: "" })) || isReadme(path))
    return {
      code: "blocked",
      message: "Wiki pages can be created only inside an existing Wiki directory"
    }
  return undefined
}

export const requireCreatable = Effect.fn("Wiki.requireCreatable")(function* (
  spaces: SpaceStore["Service"],
  snapshot: Snapshot,
  input: { readonly path: string; readonly authority: WikiLocationAuthority }
): Effect.fn.Return<void, WikiError> {
  const refused = createRefusal(input.path)
  if (refused !== undefined) return yield* wikiError("create", refused.code, refused.message)
  const directory = posix.dirname(input.path)
  const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "create")
  yield* requireWikiWritePaths(boundary, "create", [input.path])
  const directoryPage = snapshot.wholeSet.find(
    (record) =>
      record.resource.path.toLowerCase() ===
        (directory === "." ? "readme.md" : `${directory}/readme.md`).toLowerCase() &&
      record.page.lifecycle === "active"
  )
  if (directoryPage === undefined) {
    return yield* wikiError("create", "blocked", `Wiki directory is not mapped: ${directory}`)
  }
  const directoryIsSpaceBound = yield* isSpacePage(
    spaces,
    directoryPage.page.pageId,
    directoryPage.resource.path
  ).pipe(
    Effect.mapError((cause) =>
      wikiError("create", "storage", "Could not check Memory directory ownership", {
        pageId: directoryPage.page.pageId,
        cause
      })
    )
  )
  if (
    directoryIsSpaceBound &&
    !authorityOwnsBoundaryPage(boundary, directoryPage.page.pageId, directoryPage.resource.path)
  ) {
    return yield* wikiError(
      "create",
      "blocked",
      "Pages cannot be created inside a Space-owned directory"
    )
  }
  const existing = nameTakenBy(snapshot, input.path)
  if (existing !== undefined) {
    return yield* wikiError(
      "create",
      "conflict",
      `Wiki path or link name already exists: ${input.path}`,
      { pageId: existing.page.pageId }
    )
  }
})
