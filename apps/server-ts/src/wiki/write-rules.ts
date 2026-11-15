import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
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
import { producingAutomation, recordFolders } from "./collections.js"
import { isAutomatedOrigin, type WikiCommitIdentity, type WikiCommitOrigin } from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { normal, pageNamesForPath, parseWikiPage, writtenContent } from "./page.js"
import { followRedirect, readRecord, type PageRecord, type Snapshot } from "./snapshot.js"

export interface WikiWriter {
  readonly pageId: string
  readonly authority: WikiLocationAuthority
  readonly commit?: WikiCommitIdentity
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
  input: WikiWriter & { readonly content: string; readonly commit: WikiCommitIdentity }
): Effect.fn.Return<string, WikiError> {
  const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "restore")
  yield* requireWikiWritePaths(boundary, "restore", [current.resource.path])
  if (
    isAutomatedOrigin(input.commit.origin) &&
    producingAutomation(recordFolders(snapshot.pages), current.resource.path) !== undefined
  ) {
    return yield* wikiError(
      "restore",
      "blocked",
      "Automation runs cannot restore an automation-owned page",
      { pageId: input.pageId }
    )
  }
  if (input.commit.origin.kind === "capture") {
    const spaceBound = yield* spaces
      .hasPageBinding(current.page.pageId, current.resource.path)
      .pipe(
        Effect.mapError((cause) =>
          wikiError("restore", "storage", "Could not check Memory page ownership", {
            pageId: input.pageId,
            cause
          })
        )
      )
    if (spaceBound) {
      return yield* wikiError(
        "restore",
        "blocked",
        "Automatic Memory cannot restore a Space-owned page",
        { pageId: input.pageId }
      )
    }
  }
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
  if (
    input.commit !== undefined &&
    isAutomatedOrigin(input.commit.origin) &&
    posix.dirname(current.resource.path) === "."
  ) {
    return yield* wikiError(
      operation,
      "blocked",
      "Automation runs cannot retire a page at the Memory root",
      { pageId: input.pageId }
    )
  }
  if (
    input.commit !== undefined &&
    isAutomatedOrigin(input.commit.origin) &&
    producingAutomation(recordFolders(snapshot.pages), current.resource.path) !== undefined
  ) {
    return yield* wikiError(
      operation,
      "blocked",
      "Automation runs cannot archive an automation-owned page",
      { pageId: input.pageId }
    )
  }
  const pageIsSpaceBound = yield* spaces.hasPageBinding(input.pageId, current.resource.path).pipe(
    Effect.mapError((cause) =>
      wikiError(operation, "storage", "Could not check Space page ownership", {
        pageId: input.pageId,
        cause
      })
    )
  )
  if (pageIsSpaceBound) {
    return yield* wikiError(
      operation,
      "blocked",
      "A Space owns this Wiki page; move or archive the Space first",
      { pageId: input.pageId }
    )
  }
  if (posix.basename(current.resource.path).toLowerCase() === "readme.md") {
    const directory = posix.dirname(current.resource.path)
    const prefix = `${directory}/`
    const child = snapshot.pages.find(
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
  const remaining = snapshot.pages.filter((record) => record.page.pageId !== input.pageId)
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

/**
 * Why a page may not be created at `path`, if it may not: a page is a .md file inside an
 * existing directory, or a standing-facts page at the root; a README is never created this way.
 */
export const createRefusal = (
  path: string
): { readonly code: "invalid" | "blocked"; readonly message: string } | undefined => {
  if (!path.endsWith(".md")) return { code: "invalid", message: "Wiki page paths must end in .md" }
  if (
    (posix.dirname(path) === "." && !isStandingFactsPage({ path, pageId: "" })) ||
    posix.basename(path).toLowerCase() === "readme.md"
  )
    return {
      code: "blocked",
      message: "Wiki pages can be created only inside an existing Wiki directory"
    }
  return undefined
}

/**
 * The rules for creating a page at `path`: in a mapped folder the writer may write, outside a
 * folder a Space owns unless this run is that Space's, and, for an automated writer, outside an
 * Automation's record folder, which only that Automation fills by publishing.
 */
export const requireCreatable = Effect.fn("Wiki.requireCreatable")(function* (
  spaces: SpaceStore["Service"],
  snapshot: Snapshot,
  input: {
    readonly path: string
    readonly authority: WikiLocationAuthority
    readonly origin: WikiCommitOrigin
  }
): Effect.fn.Return<void, WikiError> {
  const refused = createRefusal(input.path)
  if (refused !== undefined) return yield* wikiError("create", refused.code, refused.message)
  const directory = posix.dirname(input.path)
  const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "create")
  yield* requireWikiWritePaths(boundary, "create", [input.path])
  const directoryPage = snapshot.pages.find(
    (record) =>
      record.resource.path.toLowerCase() ===
        (directory === "." ? "readme.md" : `${directory}/readme.md`).toLowerCase() &&
      record.page.lifecycle === "active"
  )
  if (directoryPage === undefined) {
    return yield* wikiError("create", "blocked", `Wiki directory is not mapped: ${directory}`)
  }
  if (
    isAutomatedOrigin(input.origin) &&
    producingAutomation(recordFolders(snapshot.pages), input.path) !== undefined
  ) {
    return yield* wikiError(
      "create",
      "blocked",
      "Automation pages in an owned directory must use report publication"
    )
  }
  const directoryIsSpaceBound = yield* spaces
    .hasPageBinding(directoryPage.page.pageId, directoryPage.resource.path)
    .pipe(
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
  const targetNames = new Set(pageNamesForPath(input.path).map((name) => normal(name)))
  const existing = snapshot.pages.find((record) =>
    pageNamesForPath(record.resource.path).some((name) => targetNames.has(normal(name)))
  )
  if (existing !== undefined) {
    return yield* wikiError(
      "create",
      "conflict",
      `Wiki path or link name already exists: ${input.path}`,
      { pageId: existing.page.pageId }
    )
  }
})

/**
 * The record rules for a rename: no page moves into an Automation's record folder, which only
 * that Automation fills, and an automated writer neither moves an Automation's page nor rewrites
 * the links in one. `origin` is undefined while the rename is only requested.
 */
export const requireRenamable = Effect.fn("Wiki.requireRenamable")(function* (
  snapshot: Snapshot,
  input: {
    readonly pageId: string
    readonly newPath: string
    readonly rewrittenPageIds: ReadonlyArray<string>
    readonly origin: WikiCommitOrigin | undefined
  }
): Effect.fn.Return<void, WikiError> {
  const folders = recordFolders(snapshot.pages)
  if (producingAutomation(folders, input.newPath) !== undefined) {
    return yield* wikiError(
      "rename",
      "blocked",
      "Publish reports through their producer instead of moving pages into its directory",
      { pageId: input.pageId }
    )
  }
  if (input.origin === undefined || !isAutomatedOrigin(input.origin)) return
  const touched = new Set([input.pageId, ...input.rewrittenPageIds])
  const produced = snapshot.pages.find(
    (record) =>
      touched.has(record.page.pageId) &&
      producingAutomation(folders, record.resource.path) !== undefined
  )
  if (produced !== undefined) {
    return yield* wikiError(
      "rename",
      "blocked",
      "Automation runs cannot move produced pages or rewrite producer-owned reports",
      { pageId: produced.page.pageId }
    )
  }
})

/**
 * A page that was merged and then brought back is separate by someone's decision. An
 * automated run that merged it again would undo that decision every time it ran.
 */
export const requireMergeable = Effect.fn("Wiki.requireMergeable")(function* (
  repository: ManagedFileRepositoryShape,
  current: PageRecord,
  input: { readonly head: string; readonly origin: WikiCommitOrigin | undefined }
): Effect.fn.Return<void, WikiError> {
  if (input.origin === undefined || !isAutomatedOrigin(input.origin)) return
  const pageId = current.page.pageId
  const history = yield* repository
    .history({ resourceId: pageId, start: input.head, limit: null })
    .pipe(Effect.mapError(mapRevisionError("merge", pageId)))
  for (const commit of history) {
    const version = commit.changes.find(
      (change) => (change.after ?? change.before)?.resourceId === pageId
    )?.after
    if (version === undefined || version === null || version.state !== "active") continue
    const earlier = yield* readRecord(repository, "merge", version)
    if (earlier.page.lifecycle === "redirect") {
      return yield* wikiError(
        "merge",
        "blocked",
        `${current.resource.path} was merged before and then restored, so it stays its own page. Leave it.`,
        { pageId }
      )
    }
  }
})
