import type {
  Commit,
  ManagedFileRepositoryShape,
  ResourceVersion
} from "@arden-hq/revisions/effect"
import type { WikiPage, WikiPageSummary, WikiResourceVersion } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"

import { mapRevisionError, WikiError, wikiError, type WikiOperation } from "./errors.js"
import type { WikiLinkToken } from "./links.js"
import {
  normal,
  pageNamesForPath,
  parseWikiPage,
  type ParsedWikiPage,
  wikiPageExcerpt
} from "./page.js"
import type { PageTimes } from "./timestamps.js"

export interface PageRecord {
  readonly resource: ResourceVersion
  readonly page: ParsedWikiPage
}

export interface Snapshot {
  readonly head: string | null
  readonly pages: ReadonlyArray<PageRecord>
}

export const notFound = (operation: WikiOperation, pageId: string): WikiError =>
  wikiError(operation, "not_found", `Unknown Wiki page: ${pageId}`, { pageId })

export const readSnapshotPage = Effect.fn("Wiki.readSnapshotPage")(function* (
  snapshot: Snapshot,
  pageId: string
): Effect.fn.Return<PageRecord, WikiError> {
  const record = snapshot.pages.find((candidate) => candidate.page.pageId === pageId)
  if (record === undefined) return yield* notFound("read", pageId)
  return record
})

export const readSnapshotContent = Effect.fn("Wiki.readSnapshotContent")(function* (
  snapshot: Snapshot,
  pageId: string
): Effect.fn.Return<Pick<WikiPage, "pageId" | "path" | "content">, WikiError> {
  const record = yield* readSnapshotPage(snapshot, pageId)
  const page = detail(record, snapshot.head)
  return { pageId: page.pageId, path: page.path, content: page.content }
})

const corruptPage = (
  operation: WikiOperation,
  resource: ResourceVersion,
  cause: unknown
): WikiError =>
  wikiError(operation, "corrupt", `Invalid Wiki page ${resource.path}`, {
    pageId: resource.resourceId,
    cause
  })

export const readRecord = Effect.fn("Wiki.readRecord")(function* (
  repository: ManagedFileRepositoryShape,
  operation: WikiOperation,
  resource: ResourceVersion,
  invalidReason: "invalid" | "corrupt" = "corrupt"
): Effect.fn.Return<PageRecord, WikiError> {
  const bytes = yield* repository
    .readVersion(resource)
    .pipe(Effect.mapError(mapRevisionError(operation, resource.resourceId)))
  const content = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      invalidReason === "corrupt"
        ? corruptPage(operation, resource, cause)
        : wikiError(operation, "invalid", "Wiki page must be valid UTF-8", {
            pageId: resource.resourceId,
            cause
          })
  })
  const page = yield* parseWikiPage(content, resource.resourceId).pipe(
    Effect.mapError((cause) =>
      invalidReason === "corrupt"
        ? corruptPage(operation, resource, cause)
        : wikiError(operation, "invalid", cause.message, { pageId: resource.resourceId, cause })
    )
  )
  return { resource, page }
})

const pageNames = (record: PageRecord): ReadonlyArray<string> =>
  pageNamesForPath(record.resource.path)

export const pageNameIndex = (
  pages: ReadonlyArray<PageRecord>
): ReadonlyMap<string, ReadonlySet<string>> => {
  const names = new Map<string, Set<string>>()
  for (const page of pages) {
    for (const name of pageNames(page)) {
      const key = normal(name)
      const entries = names.get(key) ?? new Set<string>()
      entries.add(page.page.pageId)
      names.set(key, entries)
    }
  }
  return names
}

export const followRedirect = (
  pages: ReadonlyMap<string, PageRecord>,
  start: string
): string | null => {
  const seen = new Set<string>()
  let pageId = start
  while (!seen.has(pageId)) {
    seen.add(pageId)
    const record = pages.get(pageId)
    if (record === undefined) return null
    if (record.page.lifecycle === "active") return pageId
    if (record.page.redirectTo === null) return null
    pageId = record.page.redirectTo
  }
  return null
}

export const redirectTargetAt = (snapshot: Snapshot, path: string): PageRecord | null => {
  const wanted = normal(path)
  const redirect = snapshot.pages.find(
    (record) =>
      record.page.lifecycle === "redirect" &&
      pageNamesForPath(record.resource.path).some((name) => normal(name) === wanted)
  )
  if (redirect === undefined) return null
  const byId = new Map(snapshot.pages.map((record) => [record.page.pageId, record] as const))
  const target = followRedirect(byId, redirect.page.pageId)
  return target === null ? null : (byId.get(target) ?? null)
}

export const resolveWikiLinkTarget = (
  pages: ReadonlyMap<string, PageRecord>,
  names: ReadonlyMap<string, ReadonlySet<string>>,
  sourcePageId: string,
  token: WikiLinkToken
): string | null => {
  if (token.page === null) return sourcePageId
  const candidates = names.get(normal(token.page))
  if (candidates?.size !== 1) return null
  const candidate = candidates.values().next().value
  return candidate === undefined ? null : followRedirect(pages, candidate)
}

export const validateRedirects = (
  operation: WikiOperation,
  pages: ReadonlyArray<PageRecord>
): Effect.Effect<void, WikiError> => {
  const byId = new Map(pages.map((record) => [record.page.pageId, record] as const))
  for (const record of pages) {
    if (record.page.lifecycle === "redirect" && followRedirect(byId, record.page.pageId) === null) {
      return Effect.fail(
        wikiError(
          operation,
          "corrupt",
          `Redirect ${record.page.pageId} has a missing target or cycle`,
          { pageId: record.page.pageId }
        )
      )
    }
  }
  return Effect.void
}

const recordKey = (resource: ResourceVersion): string =>
  `${resource.resourceId}\u0000${resource.blobId}`

export const loadSnapshot = Effect.fn("Wiki.loadSnapshot")(function* (
  repository: ManagedFileRepositoryShape,
  operation: WikiOperation,
  previous?: Snapshot
): Effect.fn.Return<Snapshot, WikiError> {
  const head = yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError(operation)))
  const resources = yield* repository
    .listResources({ at: head })
    .pipe(Effect.mapError(mapRevisionError(operation)))
  const parsed = new Map(
    (previous?.pages ?? []).map((record) => [recordKey(record.resource), record.page] as const)
  )
  const pages = yield* Effect.forEach(
    resources.filter((resource) => resource.path.endsWith(".md")),
    (resource) => {
      const page = parsed.get(recordKey(resource))
      return page === undefined
        ? readRecord(repository, operation, resource)
        : Effect.succeed({ resource, page })
    },
    { concurrency: 8 }
  )
  pages.sort((left, right) => left.page.pageId.localeCompare(right.page.pageId))
  yield* validateRedirects(operation, pages)
  return { head, pages }
})

const excerpts = new WeakMap<ParsedWikiPage, string | null>()
const pageExcerpt = (page: ParsedWikiPage): string | null => {
  if (excerpts.has(page)) return excerpts.get(page) ?? null
  const excerpt = wikiPageExcerpt(page.body)
  excerpts.set(page, excerpt)
  return excerpt
}

const mapVersion = (version: ResourceVersion | null): WikiResourceVersion | null =>
  version === null
    ? null
    : {
        resourceId: version.resourceId,
        path: version.path,
        state: version.state,
        versionId: version.versionId
      }

export const mapHistory = (commit: Commit) => ({
  commitId: commit.commitId,
  parentId: commit.parentId,
  actor: commit.actor,
  origin: commit.origin,
  reason: commit.reason,
  timestamp: commit.timestamp,
  changes: commit.changes.map((change) => ({
    action: change.action,
    before: mapVersion(change.before),
    after: mapVersion(change.after)
  }))
})

export const summary = (
  record: PageRecord,
  head: string | null,
  times?: PageTimes
): WikiPageSummary => ({
  pageId: record.page.pageId,
  path: record.resource.path,
  resourceState: record.resource.state,
  title: record.page.title,
  excerpt: pageExcerpt(record.page),
  aliases: record.page.aliases,
  lifecycle: record.page.lifecycle,
  redirectTo: record.page.redirectTo,
  metadata: record.page.metadata,
  version: record.resource.versionId,
  repositoryHead: head,
  createdAt: times?.createdAt ?? null,
  updatedAt: times?.updatedAt ?? null
})

export const detail = (record: PageRecord, head: string | null, times?: PageTimes): WikiPage => ({
  ...summary(record, head, times),
  content: record.page.content
})
