import { Effect } from "effect"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import {
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority
} from "./authority.js"
import { isAutomatedOrigin, type WikiCommitIdentity, type WikiCommitOrigin } from "./commit.js"
import { directorySections } from "./collections.js"
import { wikiError, type WikiError } from "./errors.js"
import { parseWikiPage, writtenContent } from "./page.js"
import {
  isMonthlySummaryPath,
  KEEP_RULE_FORMS,
  MONTHLY_SUMMARY_MAX_CHARS,
  unreadableKeepRule
} from "./report-retention.js"
import { REPORT_RETENTION_AUTOMATION } from "./retire-reports.js"
import { followRedirect, type PageRecord, type Snapshot } from "./snapshot.js"

export interface WikiWriter {
  readonly pageId: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

export const isRetentionSummaryWrite = (origin: WikiCommitOrigin, path: string): boolean =>
  origin.kind === "automation" &&
  origin.automationId === REPORT_RETENTION_AUTOMATION &&
  isMonthlySummaryPath(path)

export const summaryTooLong = (chars: number): string =>
  `The monthly summary has ${chars} characters; it replaces a month of reports only when it is ${MONTHLY_SUMMARY_MAX_CHARS} or fewer. Nothing was saved. Keep fewer items and shorter links, then save it again.`

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
  return yield* requireReplacement("update", current, input)
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
  if (
    isAutomatedOrigin(input.commit.origin) &&
    Object.hasOwn(current.page.metadata, "producer_automation_id")
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
  return yield* requireReplacement("restore", current, input)
})

const requireReplacement = Effect.fn("Wiki.requireReplacement")(function* (
  operation: "update" | "restore",
  current: PageRecord,
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
  if (
    isRetentionSummaryWrite(input.commit.origin, current.resource.path) &&
    replacement.body.length > MONTHLY_SUMMARY_MAX_CHARS
  ) {
    return yield* wikiError(operation, "invalid", summaryTooLong(replacement.body.length), {
      pageId: input.pageId
    })
  }
  const keepRule =
    posix.basename(current.resource.path).toLowerCase() === "readme.md" &&
    Object.hasOwn(replacement.metadata, "producer_automation_id")
      ? unreadableKeepRule(directorySections(replacement.body).get("Retention"))
      : undefined
  if (keepRule !== undefined) {
    return yield* wikiError(
      operation,
      "invalid",
      `The retention rule "${keepRule}" was not understood, so it would keep every report. Nothing was saved. Write ${KEEP_RULE_FORMS}.`,
      { pageId: input.pageId }
    )
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
  if (isAutomatedOrigin(input.commit.origin) && posix.dirname(current.resource.path) === ".") {
    return yield* wikiError(
      operation,
      "blocked",
      "Automation runs cannot retire a page at the Memory root",
      { pageId: input.pageId }
    )
  }
  if (
    isAutomatedOrigin(input.commit.origin) &&
    Object.hasOwn(current.page.metadata, "producer_automation_id")
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
