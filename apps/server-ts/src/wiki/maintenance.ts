import { cutBytes } from "@arden-hq/std/text"
import type { Commit, ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"

import { decodeWikiOrigin, LEGACY_MAINTENANCE_ORIGIN, wikiOriginSource } from "./commit.js"
import { isContentStepOrigin } from "./content-steps.js"
import { mapRevisionError, wikiError, type WikiError, type WikiOperation } from "./errors.js"
import { isImportedPath } from "./imported.js"
import { pageWikiLinks } from "./links.js"
import {
  pageNameIndex,
  readRecord,
  resolveWikiLinkTarget,
  validateRedirects,
  type Snapshot
} from "./snapshot.js"

const MAX_CACHED_HISTORY_IDS = 2_048
const MAX_RANGE_COMMITS = 12
const MAX_DIFF_BYTES = 16 * 1_024
const MAX_BRIEF_BYTES = 96 * 1_024
const MAX_RELATED_PAGES = 20
const MAX_CURRENT_PAGE_BYTES = 256 * 1_024
const MAX_CURRENT_WIKI_BYTES = 8 * 1_024 * 1_024
const STORAGE_METADATA =
  /^([+-]?\s*(?:-\s*)?["']?(?:page_id|generated_from_revision)["']?\s*:\s*).*$/gimu

export type WikiMaintenancePreparation =
  | {
      readonly kind: "idle"
      readonly head: string | null
    }
  | {
      readonly kind: "advance"
      readonly head: string
      readonly sourceHead: string
    }
  | {
      readonly kind: "review"
      readonly sourceHead: string
      readonly markdown: string
    }

export interface WikiMaintenancePrepareInput {
  readonly processedHead: string | null
  readonly reviewerAutomationId: string
}

export interface WikiMaintenanceMethods {
  readonly prepare: (
    input: WikiMaintenancePrepareInput
  ) => Effect.Effect<WikiMaintenancePreparation, WikiError>
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8")

const sourceCategory = (commit: Commit): string => {
  const source = wikiOriginSource(decodeWikiOrigin(commit.origin))
  return source === "automation" ? "scheduled automation" : source
}

const isReviewerCommit = (commit: Commit, reviewerAutomationId: string): boolean => {
  const origin = decodeWikiOrigin(commit.origin)
  return origin.kind === "automation" && origin.automationId === reviewerAutomationId
}

const isReviewableChange = (change: {
  readonly before: { readonly path: string } | null
  readonly after: { readonly path: string } | null
}): boolean => {
  const paths = [change.before?.path, change.after?.path].filter((path) => path !== undefined)
  return paths.some((path) => path.endsWith(".md")) && !paths.some((path) => isImportedPath(path))
}

const loadMaintenanceSnapshot = Effect.fn("WikiMaintenance.loadSnapshot")(function* (
  repository: ManagedFileRepositoryShape,
  operation: WikiOperation,
  head: string
): Effect.fn.Return<Snapshot, WikiError> {
  const resources = (yield* repository
    .listResources({ at: head })
    .pipe(Effect.mapError(mapRevisionError(operation)))).filter((resource) =>
    resource.path.endsWith(".md")
  )
  let totalBytes = 0
  for (const resource of resources) {
    const size = yield* repository
      .contentSize(resource)
      .pipe(Effect.mapError(mapRevisionError(operation, resource.resourceId)))
    if (size > MAX_CURRENT_PAGE_BYTES) {
      return yield* wikiError(
        operation,
        "invalid",
        "Wiki Maintenance current page exceeds the scan limit",
        { pageId: resource.resourceId }
      )
    }
    totalBytes += size
    if (totalBytes > MAX_CURRENT_WIKI_BYTES) {
      return yield* wikiError(
        operation,
        "invalid",
        "Wiki Maintenance current Wiki exceeds the scan limit"
      )
    }
  }
  const pages = yield* Effect.forEach(
    resources,
    (resource) => readRecord(repository, operation, resource),
    { concurrency: 8 }
  )
  pages.sort((left, right) => left.page.pageId.localeCompare(right.page.pageId))
  yield* validateRedirects(operation, pages)
  return { head, pages }
})

const directReferences = (
  snapshot: Snapshot
): ReadonlyMap<string, ReadonlyArray<{ readonly targetPageId: string | null }>> => {
  const pages = snapshot.pages.filter((record) => record.page.lifecycle === "active")
  const byId = new Map(snapshot.pages.map((record) => [record.page.pageId, record] as const))
  const names = pageNameIndex(snapshot.pages)
  return new Map(
    pages.map(
      (record) =>
        [
          record.page.pageId,
          pageWikiLinks(record.page).map((token) => ({
            targetPageId: resolveWikiLinkTarget(byId, names, record.page.pageId, token)
          }))
        ] as const
    )
  )
}

const candidatePageIds = (
  changedPageIds: ReadonlySet<string>,
  references: ReadonlyMap<string, ReadonlyArray<{ readonly targetPageId: string | null }>>
): ReadonlyArray<string> => {
  const related = new Set(changedPageIds)
  for (const pageId of changedPageIds) {
    for (const reference of references.get(pageId) ?? []) {
      if (reference.targetPageId !== null) related.add(reference.targetPageId)
    }
  }
  for (const [sourcePageId, outgoing] of references) {
    if (
      outgoing.some(
        (reference) => reference.targetPageId !== null && changedPageIds.has(reference.targetPageId)
      )
    ) {
      related.add(sourcePageId)
    }
  }
  return [
    ...[...changedPageIds].sort(),
    ...[...related].filter((pageId) => !changedPageIds.has(pageId)).sort()
  ]
}

const reviewPages = (snapshot: Snapshot, pageIds: ReadonlyArray<string>) => {
  const records = new Map(snapshot.pages.map((record) => [record.page.pageId, record] as const))
  return pageIds.flatMap((pageId) => {
    const record = records.get(pageId)
    if (
      record === undefined ||
      record.page.lifecycle !== "active" ||
      isImportedPath(record.resource.path)
    )
      return []
    return [{ record, readOnly: record.resource.path.toLowerCase() === "health.md" }]
  })
}

const boundedDiff = (unifiedDiff: string): string => {
  const masked = unifiedDiff.replace(STORAGE_METADATA, "$1[opaque]")
  return cutBytes(masked, MAX_DIFF_BYTES, {
    suffix: "\n[diff truncated; read the page for its current state]"
  })
}

export const makeWikiMaintenanceMethods = (
  repository: ManagedFileRepositoryShape
): WikiMaintenanceMethods => {
  let historyCache:
    | {
        readonly head: string
        readonly stopBefore: string | null
        readonly ids: ReadonlyArray<string>
      }
    | undefined
  let snapshotCache:
    | {
        readonly snapshot: Snapshot
        readonly references: ReturnType<typeof directReferences>
      }
    | undefined

  const prepare = Effect.fn("WikiMaintenance.prepare")(function* (
    input: WikiMaintenancePrepareInput
  ) {
    const baseHead = yield* repository.currentRevision.pipe(
      Effect.mapError(mapRevisionError("list"))
    )
    if (baseHead === null) return { kind: "idle", head: null } as const
    if (historyCache?.head !== baseHead) historyCache = undefined
    let cachedEnd = -1
    if (historyCache !== undefined) {
      if (input.processedHead === historyCache.stopBefore) cachedEnd = historyCache.ids.length
      else if (input.processedHead !== null)
        cachedEnd = historyCache.ids.indexOf(input.processedHead)
    }
    let ids: ReadonlyArray<string>
    if (historyCache !== undefined && cachedEnd >= 0) {
      ids = historyCache.ids.slice(0, cachedEnd)
    } else {
      const commits = yield* repository
        .history({
          start: baseHead,
          stopBefore: input.processedHead,
          limit: null
        })
        .pipe(Effect.mapError(mapRevisionError("list")))
      ids = commits.map((commit) => commit.commitId)
      historyCache =
        ids.length <= MAX_CACHED_HISTORY_IDS
          ? { head: baseHead, stopBefore: input.processedHead, ids }
          : undefined
    }
    const sourceIds = ids.slice(-MAX_RANGE_COMMITS)
    const sourceHead = sourceIds[0]
    if (sourceHead === undefined) return { kind: "idle", head: baseHead } as const
    const sources = yield* Effect.forEach(
      sourceIds,
      (sourceId) =>
        repository.inspectCommit(sourceId).pipe(Effect.mapError(mapRevisionError("list"))),
      { concurrency: 8 }
    )
    const reviewSources = sources.filter(
      (source) =>
        source.origin !== LEGACY_MAINTENANCE_ORIGIN &&
        !isContentStepOrigin(source.origin) &&
        !isReviewerCommit(source, input.reviewerAutomationId) &&
        source.changes.some(isReviewableChange)
    )
    if (reviewSources.length === 0) {
      return {
        kind: "advance",
        head: baseHead,
        sourceHead
      } as const
    }

    const changes = reviewSources.flatMap((source) =>
      source.changes.filter(isReviewableChange).map((change) => ({ source, change }))
    )
    if (snapshotCache?.snapshot.head !== sourceHead) {
      const snapshot = yield* loadMaintenanceSnapshot(repository, "list", sourceHead)
      if (
        (yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("list")))) !==
        baseHead
      ) {
        return yield* wikiError(
          "list",
          "conflict",
          "Wiki changed while preparing Maintenance evidence"
        )
      }
      snapshotCache = { snapshot, references: directReferences(snapshot) }
    }
    const { snapshot, references } = snapshotCache
    const changedPageIds = new Set(
      changes.flatMap(({ change }) => {
        const pageId = (change.after ?? change.before)?.resourceId
        return pageId === undefined ? [] : [pageId]
      })
    )
    const pages = reviewPages(snapshot, candidatePageIds(changedPageIds, references))

    const rangeSection = [
      "## Contiguous revision range under review",
      `After processed revision: ${input.processedHead ?? "start of retained history"}`,
      `Advance through revision after success: ${sourceHead}`,
      `Pinned Wiki state for this range: ${sourceHead}`,
      "Source revisions (oldest to newest; source claims may have different evidence dates):",
      ...Array.from(sources)
        .reverse()
        .map((source) => {
          const disposition = reviewSources.includes(source) ? "review" : "structural skip"
          return `- ${source.commitId} — ${source.timestamp} — ${sourceCategory(source)} — ${disposition} — ${source.reason}`
        })
    ].join("\n")
    const sections = [rangeSection]
    let briefBytes = utf8Bytes(rangeSection)
    let omitted = 0
    for (const { source, change } of changes) {
      const resource = change.after ?? change.before
      if (resource === null) continue
      const diff = yield* repository
        .diffVersionsPage(change.before, change.action === "archive" ? null : change.after, {
          offset: 0,
          limit: MAX_DIFF_BYTES + 1,
          sourceByteLimit: MAX_CURRENT_PAGE_BYTES
        })
        .pipe(Effect.mapError(mapRevisionError("list", resource.resourceId)))
      const section = [
        `### Revision ${source.commitId}: ${change.action} ${resource.path}`,
        "```diff",
        boundedDiff(diff.unifiedDiff),
        "```"
      ].join("\n")
      const bytes = utf8Bytes(section)
      if (briefBytes + bytes > MAX_BRIEF_BYTES) {
        omitted += 1
        continue
      }
      briefBytes += bytes
      sections.push(section)
    }
    if (omitted > 0) {
      sections.push(
        `(${omitted} further changes omitted; read the changed pages for their current state)`
      )
    }
    sections.push(
      [
        "## Discovery starting points (not a complete review scope)",
        "These paths and links are pinned to the range end above. Live reads can be newer; never overwrite newer evidence. Unlinked summaries can also contradict the changed facts.",
        ...pages
          .slice(0, MAX_RELATED_PAGES)
          .map(
            ({ record, readOnly }) =>
              `- ${record.resource.path} — ${record.page.title}${readOnly ? " [read-only evidence]" : ""}`
          ),
        ...(pages.length > MAX_RELATED_PAGES
          ? [
              `(${pages.length - MAX_RELATED_PAGES} more related pages exist; find them with wiki_links)`
            ]
          : [])
      ].join("\n")
    )

    if (
      (yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("list")))) !==
      baseHead
    ) {
      return yield* wikiError(
        "list",
        "conflict",
        "Wiki changed while preparing Maintenance evidence"
      )
    }

    return {
      kind: "review",
      sourceHead,
      markdown: sections.join("\n\n")
    } as const
  })

  return { prepare }
}
