import type {
  CollectionReport,
  Commit,
  ManagedFileRepositoryShape,
  ResourceVersion
} from "@arden-hq/revisions/effect"
import type {
  WikiDiffRouteOptions,
  WikiHistoryRouteOptions,
  WikiLink,
  WikiPageDiff,
  WikiPageHistoryResponse,
  WikiPageLinks,
  WikiVersionDiff,
  WikiVersionDiffRouteOptions
} from "@arden-hq/protocol/wiki"
import { diffLines } from "diff"
import { Effect } from "effect"

import { decodeWikiOrigin, wikiOriginChat } from "./commit.js"
import { mapRevisionError, type WikiError, wikiError } from "./errors.js"
import { pageWikiLinks, type WikiLinkToken } from "./links.js"
import {
  mapHistory,
  notFound,
  pageNameIndex,
  readRecord,
  resolveWikiLinkTarget,
  type Snapshot
} from "./snapshot.js"

export interface WikiHistoryMethods {
  readonly prepareHistory: () => Effect.Effect<void, WikiError>
  readonly collectHistory: (options: {
    readonly gracePeriodDays: number
  }) => Effect.Effect<CollectionReport, WikiError>
  readonly history: (
    pageId: string,
    options?: WikiHistoryRouteOptions
  ) => Effect.Effect<WikiPageHistoryResponse, WikiError>
  readonly diff: (
    pageId: string,
    options?: WikiDiffRouteOptions
  ) => Effect.Effect<WikiPageDiff, WikiError>
  readonly versionDiff: (
    pageId: string,
    options: WikiVersionDiffRouteOptions
  ) => Effect.Effect<WikiVersionDiff, WikiError>
  readonly links: (
    pageId: string
  ) => Effect.Effect<
    Pick<WikiPageLinks, "pageId" | "repositoryHead" | "outgoing" | "backlinks">,
    WikiError
  >
  readonly pageChats: (
    pageIds: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<WikiPageChat>>, WikiError>
}

const VERSION_SEARCH_COMMITS = 500
const VERSION_DIFF_CHARS = 65_536

const live = (version: ResourceVersion | null): ResourceVersion | null =>
  version?.state === "archived" ? null : version

interface WikiPageChat {
  readonly sessionId: string
  readonly savedAt: string
}

export const makeWikiHistoryMethods = (
  repository: ManagedFileRepositoryShape,
  snapshot: () => Effect.Effect<Snapshot, WikiError>
): WikiHistoryMethods => {
  const collectHistory = Effect.fn("Wiki.collectHistory")(function* (options: {
    readonly gracePeriodDays: number
  }) {
    return yield* repository
      .collect({ gracePeriodMs: options.gracePeriodDays * 24 * 60 * 60 * 1000 })
      .pipe(Effect.mapError(mapRevisionError("list")))
  })

  const history = Effect.fn("Wiki.history")(function* (
    pageId: string,
    options: WikiHistoryRouteOptions = {}
  ) {
    const head = yield* repository.currentRevision.pipe(
      Effect.mapError(mapRevisionError("history", pageId))
    )
    if (head === null) return yield* notFound("history", pageId)
    const resource = yield* repository
      .get(pageId, { at: head })
      .pipe(Effect.mapError(mapRevisionError("history", pageId)))
    if (resource === null || resource.state !== "active" || !resource.path.endsWith(".md")) {
      return yield* notFound("history", pageId)
    }
    yield* readRecord(repository, "history", resource)
    const commits = yield* repository
      .history({
        resourceId: pageId,
        start: head,
        limit: options.limit ?? 50
      })
      .pipe(Effect.mapError(mapRevisionError("history", pageId)))
    const readText = (version: ResourceVersion | null) =>
      version === null
        ? Effect.succeed("")
        : repository.readVersion(version).pipe(
            Effect.map((bytes) => new TextDecoder().decode(bytes)),
            Effect.mapError(mapRevisionError("history", pageId))
          )
    const summarize = Effect.fn("Wiki.historySummary")(function* (commit: Commit) {
      const change = commit.changes.find(
        (item) => (item.after ?? item.before)?.resourceId === pageId
      )
      if (change === undefined) {
        return yield* wikiError(
          "history",
          "storage",
          "Page history commit has no matching change",
          { pageId }
        )
      }
      const before = yield* readText(change.before)
      const after = yield* readText(change.after)
      let addedLines = 0
      let removedLines = 0
      for (const part of diffLines(before, after)) {
        if (part.added) addedLines += part.count
        else if (part.removed) removedLines += part.count
      }
      return { ...mapHistory(commit), addedLines, removedLines }
    })
    const summaries = yield* Effect.forEach(commits, summarize, { concurrency: 8 })
    return { pageId, repositoryHead: head, commits: summaries }
  })

  const diff = Effect.fn("Wiki.diff")(function* (
    pageId: string,
    options: WikiDiffRouteOptions = {}
  ) {
    const head = yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("diff")))
    const target = options.target ?? head
    if (target === null) return yield* notFound("diff", pageId)
    const page = yield* repository
      .diffPage(options.base ?? null, target, pageId, {
        offset: options.offset ?? 0,
        limit: options.limit ?? 65_536,
        tail: options.tail ?? false
      })
      .pipe(Effect.mapError(mapRevisionError("diff", pageId)))
    return {
      offset: page.offset,
      endOffset: page.endOffset,
      base: options.base ?? null,
      target,
      hasMore: page.hasMore,
      unifiedDiff: page.unifiedDiff
    }
  })

  const versionDiff = Effect.fn("Wiki.versionDiff")(function* (
    pageId: string,
    options: WikiVersionDiffRouteOptions
  ) {
    const head = yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("diff")))
    if (head === null) return yield* notFound("diff", pageId)
    const commits = yield* repository
      .history({ resourceId: pageId, start: head, limit: VERSION_SEARCH_COMMITS })
      .pipe(Effect.mapError(mapRevisionError("diff", pageId)))
    const known = new Map<string, ResourceVersion>()
    for (const commit of commits)
      for (const change of commit.changes)
        for (const version of [change.before, change.after])
          if (version?.resourceId === pageId) known.set(version.versionId, version)
    const after = known.get(options.after)
    const before = options.before === "absent" ? null : known.get(options.before)
    if (after === undefined || before === undefined) return yield* notFound("diff", pageId)
    const page = yield* repository
      .diffVersionsPage(live(before), live(after), { offset: 0, limit: VERSION_DIFF_CHARS })
      .pipe(Effect.mapError(mapRevisionError("diff", pageId)))
    return { hasMore: page.hasMore, unifiedDiff: page.unifiedDiff }
  })

  const links = Effect.fn("Wiki.links")(function* (pageId: string) {
    const current = yield* snapshot()
    const byId = new Map(current.pages.map((record) => [record.page.pageId, record] as const))
    const record = byId.get(pageId)
    if (record === undefined || record.page.lifecycle !== "active") {
      return yield* notFound("links", pageId)
    }
    const names = pageNameIndex(current.pages)
    const reference = (sourcePageId: string, token: WikiLinkToken): WikiLink => {
      const targetPageId = resolveWikiLinkTarget(byId, names, sourcePageId, token)
      return {
        sourcePageId,
        target:
          token.fragment === null ? (token.page ?? "") : `${token.page ?? ""}#${token.fragment}`,
        alias: token.alias,
        heading: token.fragment,
        status: targetPageId === null ? "unresolved" : "resolved",
        targetPageId
      }
    }
    const outgoing = pageWikiLinks(record.page).map((token) => reference(pageId, token))
    const backlinks: WikiLink[] = []
    for (const source of current.pages) {
      for (const token of pageWikiLinks(source.page)) {
        const item = reference(source.page.pageId, token)
        if (item.targetPageId === pageId) backlinks.push(item)
      }
    }
    return {
      pageId,
      repositoryHead: current.head,
      outgoing,
      backlinks
    }
  })

  const indexed = new Map<
    string,
    { readonly head: string | null; readonly chats: ReadonlyArray<WikiPageChat> }
  >()
  const pageChats = Effect.fn("Wiki.pageChats")(function* (pageIds: ReadonlyArray<string>) {
    const result = new Map<string, ReadonlyArray<WikiPageChat>>()
    if (pageIds.length === 0) return result
    const previousIndex = new Map(indexed)
    const head = yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("list")))
    for (const pageId of new Set(pageIds)) {
      const previous = previousIndex.get(pageId)
      if (previous !== undefined && previous.head === head) {
        result.set(pageId, previous.chats)
        continue
      }
      const newer =
        head === null
          ? []
          : yield* repository
              .history({
                resourceId: pageId,
                start: head,
                stopBefore: previous?.head ?? null,
                limit: null
              })
              .pipe(Effect.mapError(mapRevisionError("list")))
      const chats: WikiPageChat[] = []
      const seen = new Set<string>()
      for (const commit of newer) {
        const sessionId = wikiOriginChat(decodeWikiOrigin(commit.origin))
        if (sessionId === undefined || seen.has(sessionId)) continue
        seen.add(sessionId)
        chats.push({ sessionId, savedAt: commit.timestamp })
      }
      if (head !== null) {
        for (const chat of previous?.chats ?? []) {
          if (!seen.has(chat.sessionId)) chats.push(chat)
        }
      }
      if (indexed.get(pageId) === previous) indexed.set(pageId, { head, chats })
      result.set(pageId, chats)
    }
    return result
  })

  return {
    collectHistory,
    history,
    diff,
    versionDiff,
    links,
    pageChats,
    prepareHistory: () =>
      repository.prepareHistory().pipe(Effect.mapError(mapRevisionError("history")))
  }
}
