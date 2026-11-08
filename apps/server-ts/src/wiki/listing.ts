import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import type { WikiPage, WikiPageListOptions, WikiPagePage } from "@arden-hq/protocol/wiki"
import { WIKI_PAGE_DEFAULT_LIMIT, WIKI_PAGE_MAX_LIMIT } from "@arden-hq/protocol/wiki"
import { DateTime, Effect, Option, Schema } from "effect"

import { mapRevisionError, type WikiError, wikiError } from "./errors.js"
import {
  detail,
  loadSnapshot,
  readSnapshotPage,
  summary,
  type PageRecord,
  type Snapshot
} from "./snapshot.js"
import { WikiPageTimestampCache } from "./timestamps.js"
import { decodeOpaque, encodeOpaque } from "../lib/opaque-ref.js"

interface WikiListChangesInput {
  readonly since: string
  readonly offset: number
  readonly limit: number
}

interface WikiChangeEntry {
  readonly revision: string
  readonly timestamp: string
  readonly actor: string
  readonly origin: string
  readonly reason: string
  readonly changes: ReadonlyArray<{
    readonly action: string
    readonly path: string
    readonly beforePath: string | null
    readonly afterPath: string | null
  }>
}

interface WikiChangesPage {
  readonly entries: ReadonlyArray<WikiChangeEntry>
  readonly hasMore: boolean
}

export interface WikiListingMethods {
  readonly head: () => Effect.Effect<string | null, WikiError>
  readonly snapshot: () => Effect.Effect<Snapshot, WikiError>
  readonly list: (options?: WikiPageListOptions) => Effect.Effect<WikiPagePage, WikiError>
  readonly listChanges: (input: WikiListChangesInput) => Effect.Effect<WikiChangesPage, WikiError>
  readonly read: (pageId: string) => Effect.Effect<WikiPage, WikiError>
}

interface WikiListCursor {
  readonly repositoryHead: string | null
  readonly path: string
  readonly pageId: string
  readonly includeRedirects: boolean
}

const WikiListCursorSchema = Schema.Struct({
  repositoryHead: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
  ),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  pageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  includeRedirects: Schema.Boolean
})

const decodeWikiListCursor = Effect.fn("Wiki.decodeListCursor")(function* (value: string) {
  const decoded = decodeOpaque(WikiListCursorSchema, value)
  if (Option.isNone(decoded)) return yield* wikiError("list", "invalid", "Invalid Wiki page cursor")
  return decoded.value
})

const encodeWikiListCursor = (
  repositoryHead: string | null,
  record: PageRecord,
  includeRedirects: boolean
): string =>
  encodeOpaque({
    repositoryHead,
    path: record.resource.path,
    pageId: record.page.pageId,
    includeRedirects
  } satisfies WikiListCursor)

const compareText = (left: string, right: string): number => {
  if (left === right) return 0
  return left < right ? -1 : 1
}

const compareWikiPage = (left: PageRecord, right: PageRecord): number =>
  left.resource.path === right.resource.path
    ? compareText(left.page.pageId, right.page.pageId)
    : compareText(left.resource.path, right.resource.path)

const afterWikiCursor = (record: PageRecord, cursor: WikiListCursor): boolean =>
  record.resource.path > cursor.path ||
  (record.resource.path === cursor.path && record.page.pageId > cursor.pageId)

const MAX_WIKI_CHANGE_OFFSET = 10_000
const MAX_WIKI_CHANGE_LIMIT = 200

export const makeWikiListingMethods = (
  repository: ManagedFileRepositoryShape
): WikiListingMethods => {
  const pageTimestamps = new WikiPageTimestampCache(repository)

  const head = Effect.fn("Wiki.head")(function* () {
    return yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("list")))
  })

  let cached: Snapshot | undefined
  const snapshot = Effect.fn("Wiki.snapshot")(function* () {
    const current = yield* head()
    if (cached?.head === current) return cached
    const loaded = yield* loadSnapshot(repository, "list", cached)
    cached = loaded
    return loaded
  })

  const list = Effect.fn("Wiki.list")(function* (options: WikiPageListOptions = {}) {
    const current = yield* snapshot()
    const includeRedirects = options.includeRedirects === true
    const limit = options.limit ?? WIKI_PAGE_DEFAULT_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WIKI_PAGE_MAX_LIMIT) {
      return yield* wikiError("list", "invalid", "Invalid Wiki page limit")
    }
    const cursor = options.cursor === undefined ? null : yield* decodeWikiListCursor(options.cursor)
    if (
      cursor !== null &&
      (cursor.repositoryHead !== current.head || cursor.includeRedirects !== includeRedirects)
    ) {
      return yield* wikiError("list", "conflict", "Wiki changed while reading pages")
    }
    const shown = [
      ...(includeRedirects
        ? current.pages
        : current.pages.filter((record) => record.page.lifecycle === "active"))
    ]
      .sort(compareWikiPage)
      .filter((record) => cursor === null || afterWikiCursor(record, cursor))
    const selected = shown.slice(0, limit)
    const last = selected.at(-1)
    const times = yield* pageTimestamps
      .forPages(current.head, new Set(selected.map((record) => record.page.pageId)))
      .pipe(Effect.mapError(mapRevisionError("list")))
    return {
      repositoryHead: current.head,
      pages: selected.map((record) => summary(record, current.head, times.get(record.page.pageId))),
      nextCursor:
        shown.length > limit && last !== undefined
          ? encodeWikiListCursor(current.head, last, includeRedirects)
          : null
    }
  })

  const listChanges = Effect.fn("Wiki.listChanges")(function* (input: WikiListChangesInput) {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > MAX_WIKI_CHANGE_OFFSET ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_WIKI_CHANGE_LIMIT
    ) {
      return yield* wikiError("list", "invalid", "Invalid Wiki change page bounds")
    }
    const since = yield* Schema.decodeUnknownEffect(IsoDateTimeStringSchema)(input.since).pipe(
      Effect.mapError((cause) =>
        wikiError("list", "invalid", "Invalid Wiki change timestamp", { cause })
      )
    )
    const sinceDateTime = DateTime.make(since)
    if (Option.isNone(sinceDateTime)) {
      return yield* wikiError("list", "invalid", "Invalid Wiki change timestamp")
    }
    const commits = yield* repository
      .history({ limit: input.offset + input.limit + 1 })
      .pipe(Effect.mapError(mapRevisionError("list")))
    const recent: Array<(typeof commits)[number]> = []
    for (const commit of commits) {
      const timestamp = DateTime.make(commit.timestamp)
      if (Option.isNone(timestamp)) {
        return yield* wikiError("list", "corrupt", "Wiki history contains an invalid timestamp")
      }
      if (DateTime.toEpochMillis(timestamp.value) >= DateTime.toEpochMillis(sinceDateTime.value)) {
        recent.push(commit)
      }
    }
    const visible = recent.slice(input.offset, input.offset + input.limit)
    const entries = yield* Effect.try({
      try: (): ReadonlyArray<WikiChangeEntry> =>
        visible.map((commit) => ({
          revision: commit.commitId,
          timestamp: commit.timestamp,
          actor: commit.actor,
          origin: commit.origin,
          reason: commit.reason,
          changes: commit.changes.map((change) => {
            const path = change.after?.path ?? change.before?.path
            if (path === undefined) throw new Error("revision change has no path")
            return {
              action: change.action,
              path,
              beforePath: change.before?.path ?? null,
              afterPath: change.after?.path ?? null
            }
          })
        })),
      catch: (cause) =>
        wikiError("list", "corrupt", "Wiki history contains an invalid change", { cause })
    })
    return {
      entries,
      hasMore: recent.length > input.offset + visible.length
    }
  })

  const read = Effect.fn("Wiki.read")(function* (pageId: string) {
    const current = yield* snapshot()
    const record = yield* readSnapshotPage(current, pageId)
    const times = yield* pageTimestamps
      .forPages(current.head, new Set([pageId]))
      .pipe(Effect.mapError(mapRevisionError("read", pageId)))
    return detail(record, current.head, times.get(pageId))
  })

  return { head, snapshot, list, listChanges, read }
}
