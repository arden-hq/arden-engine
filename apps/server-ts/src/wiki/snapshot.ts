import type {
  Commit,
  ManagedFileRepositoryShape,
  ResourceVersion
} from "@arden-hq/revisions/effect"
import {
  WIKI_CHANGE_ACTION,
  WIKI_COMMIT_PARENT,
  WIKI_EXCERPT,
  WIKI_MOMENT,
  WIKI_PAGE_LIFECYCLE,
  type WikiEditAction,
  type WikiHistoryChange,
  type WikiHistoryCommit,
  type WikiMoment,
  type WikiPage,
  type WikiPageLifecycle,
  type WikiPageSummary,
  type WikiResourceVersion
} from "@arden-hq/protocol/wiki"
import { Effect } from "effect"

import { mapRevisionError, WikiError, wikiError, type WikiOperation } from "./errors.js"
import type { WikiLinkToken } from "./links.js"
import {
  nameKeys,
  namesTakenAt,
  normal,
  parseWikiPage,
  takesName,
  type ParsedWikiPage,
  wikiPageExcerpt
} from "./page.js"
import { codeOwnedPage, isCodeOwnedPage } from "./code-owned-pages.js"
import type { PageTimes } from "./timestamps.js"

export interface PageRecord {
  readonly resource: ResourceVersion
  readonly page: ParsedWikiPage
}

declare const shownToRuns: unique symbol

/** A page a run may be shown. Only `snapshotOf` makes one, and never of a code-owned page. */
export type RunPage = PageRecord & { readonly [shownToRuns]: true }

export interface Snapshot {
  readonly head: string | null
  readonly pages: ReadonlyArray<RunPage>
  readonly wholeSet: ReadonlyArray<PageRecord>
}

const isShownToRuns = (record: PageRecord): record is RunPage =>
  !isCodeOwnedPage(record.resource.path)

export const snapshotOf = (head: string | null, wholeSet: ReadonlyArray<PageRecord>): Snapshot => ({
  head,
  pages: wholeSet.filter(isShownToRuns),
  wholeSet
})

/** The run pages a run may find, read or write: active in history and in lifecycle. */
export const activeRunPages = (pages: ReadonlyArray<RunPage>): ReadonlyArray<RunPage> =>
  pages.filter((record) => record.resource.state === "active" && record.page.lifecycle === "active")

export const notFound = (operation: WikiOperation, pageId: string): WikiError =>
  wikiError(operation, "not_found", `Unknown Memory page: ${pageId}`, { pageId })

export const readSnapshotPage = Effect.fn("Wiki.readSnapshotPage")(function* (
  snapshot: Snapshot,
  pageId: string
): Effect.fn.Return<{ readonly record: PageRecord; readonly head: string }, WikiError> {
  const record = snapshot.wholeSet.find((candidate) => candidate.page.pageId === pageId)
  if (record === undefined || snapshot.head === null) return yield* notFound("read", pageId)
  return { record, head: snapshot.head }
})

export const readSnapshotContent = Effect.fn("Wiki.readSnapshotContent")(function* (
  snapshot: Snapshot,
  pageId: string
): Effect.fn.Return<Pick<WikiPage, "pageId" | "path" | "version" | "content">, WikiError> {
  const record = snapshot.pages.find((candidate) => candidate.page.pageId === pageId)
  if (record === undefined || snapshot.head === null) return yield* notFound("read", pageId)
  const page = detail(record, snapshot.head)
  return { pageId: page.pageId, path: page.path, version: page.version, content: page.content }
})

const corruptPage = (
  operation: WikiOperation,
  resource: ResourceVersion,
  cause: unknown
): WikiError =>
  wikiError(operation, "corrupt", `Invalid Memory page ${resource.path}`, {
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
        : wikiError(operation, "invalid", "Memory page must be valid UTF-8", {
            pageId: resource.resourceId,
            cause
          })
  })
  const page = yield* parseWikiPage(
    content,
    resource.resourceId,
    codeOwnedPage(resource.path)?.plainTitle
  ).pipe(
    Effect.mapError((cause) =>
      invalidReason === "corrupt"
        ? corruptPage(operation, resource, cause)
        : wikiError(operation, "invalid", cause.message, { pageId: resource.resourceId, cause })
    )
  )
  return { resource, page }
})

export const pageNameIndex = (
  pages: ReadonlyArray<PageRecord>
): ReadonlyMap<string, ReadonlySet<string>> => {
  const names = new Map<string, Set<string>>()
  for (const page of pages) {
    for (const key of nameKeys(page.resource.path)) {
      const entries = names.get(key) ?? new Set<string>()
      entries.add(page.page.pageId)
      names.set(key, entries)
    }
  }
  return names
}

/** The page of the whole set that holds a name a page at `path` would take, but `exceptPageId`. */
export const nameTakenBy = (
  snapshot: Pick<Snapshot, "wholeSet">,
  path: string,
  exceptPageId?: string
): PageRecord | undefined => {
  const wanted = namesTakenAt([path])
  return snapshot.wholeSet.find(
    (record) => record.page.pageId !== exceptPageId && takesName(wanted, record.resource.path)
  )
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

export const redirectTargetAt = (snapshot: Snapshot, path: string): RunPage | null => {
  const wanted = normal(path)
  const redirect = snapshot.pages.find(
    (record) =>
      record.page.lifecycle === "redirect" && nameKeys(record.resource.path).includes(wanted)
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

/** The active README that maps `directory`; "." is the Memory root. */
export const directoryReadme = (
  pages: ReadonlyArray<PageRecord>,
  directory: string
): PageRecord | undefined => {
  const readme = (directory === "." ? "readme.md" : `${directory}/readme.md`).toLowerCase()
  return pages.find(
    (record) => record.resource.path.toLowerCase() === readme && record.page.lifecycle === "active"
  )
}

/** A redirect among `pages` whose target is missing or loops back. */
export const brokenRedirect = (pages: ReadonlyArray<PageRecord>): PageRecord | undefined => {
  const byId = new Map(pages.map((record) => [record.page.pageId, record] as const))
  return pages.find(
    (record) =>
      record.page.lifecycle === "redirect" && followRedirect(byId, record.page.pageId) === null
  )
}

export const validateRedirects = (
  operation: WikiOperation,
  pages: ReadonlyArray<PageRecord>
): Effect.Effect<void, WikiError> => {
  const broken = brokenRedirect(pages)
  return broken === undefined
    ? Effect.void
    : Effect.fail(
        wikiError(
          operation,
          "corrupt",
          `Redirect ${broken.page.pageId} has a missing target or cycle`,
          { pageId: broken.page.pageId }
        )
      )
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
    (previous?.wholeSet ?? []).map((record) => [recordKey(record.resource), record.page] as const)
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
  return snapshotOf(head, pages)
})

const excerpts = new WeakMap<ParsedWikiPage, string | null>()
const pageExcerpt = (page: ParsedWikiPage): string | null => {
  if (excerpts.has(page)) return excerpts.get(page) ?? null
  const excerpt = wikiPageExcerpt(page.body)
  excerpts.set(page, excerpt)
  return excerpt
}

const mapVersion = (version: ResourceVersion): WikiResourceVersion => ({
  resourceId: version.resourceId,
  path: version.path,
  state: version.state,
  versionId: version.versionId
})

const WIKI_EDIT_ACTIONS: ReadonlyArray<WikiEditAction> = [
  WIKI_CHANGE_ACTION.update,
  WIKI_CHANGE_ACTION.move,
  WIKI_CHANGE_ACTION.archive,
  WIKI_CHANGE_ACTION.restore
]

const isEditAction = (action: string): action is WikiEditAction =>
  WIKI_EDIT_ACTIONS.some((known) => known === action)

const mapChange = (change: Commit["changes"][number]): ReadonlyArray<WikiHistoryChange> => {
  if (change.after === null) return []
  if (change.before === null) {
    return [{ action: WIKI_CHANGE_ACTION.create, after: mapVersion(change.after) }]
  }
  if (!isEditAction(change.action)) return []
  return [
    { action: change.action, before: mapVersion(change.before), after: mapVersion(change.after) }
  ]
}

export const mapHistory = (
  commit: Commit
): Pick<
  WikiHistoryCommit,
  "commitId" | "parent" | "actor" | "origin" | "reason" | "timestamp" | "changes"
> => ({
  commitId: commit.commitId,
  parent:
    commit.parentId === null
      ? { kind: WIKI_COMMIT_PARENT.root }
      : { kind: WIKI_COMMIT_PARENT.commit, id: commit.parentId },
  actor: commit.actor,
  origin: commit.origin,
  reason: commit.reason,
  timestamp: commit.timestamp,
  changes: commit.changes.flatMap(mapChange)
})

export const pageLifecycle = (page: ParsedWikiPage): WikiPageLifecycle =>
  page.redirectTo === null
    ? { kind: WIKI_PAGE_LIFECYCLE.active }
    : { kind: WIKI_PAGE_LIFECYCLE.redirect, to: page.redirectTo }

const moment = (at: string | null | undefined): WikiMoment =>
  at === null || at === undefined ? { kind: WIKI_MOMENT.unrecorded } : { kind: WIKI_MOMENT.at, at }

export const summary = (record: PageRecord, head: string, times?: PageTimes): WikiPageSummary => {
  const excerpt = pageExcerpt(record.page)
  return {
    pageId: record.page.pageId,
    path: record.resource.path,
    resourceState: record.resource.state,
    title: record.page.title,
    excerpt:
      excerpt === null ? { kind: WIKI_EXCERPT.blank } : { kind: WIKI_EXCERPT.text, text: excerpt },
    aliases: record.page.aliases,
    lifecycle: pageLifecycle(record.page),
    metadata: record.page.metadata,
    version: record.resource.versionId,
    repositoryHead: head,
    created: moment(times?.createdAt),
    updated: moment(times?.updatedAt)
  }
}

export const detail = (record: PageRecord, head: string, times?: PageTimes): WikiPage => ({
  ...summary(record, head, times),
  content: record.page.content
})
