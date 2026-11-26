import type { JsonRecord, JsonValue } from "../common/json.js"

export const WIKI_PAGE_DEFAULT_LIMIT = 100
export const WIKI_PAGE_MAX_LIMIT = 100
export const WIKI_HISTORY_DEFAULT_LIMIT = 50

/** Producer-owned report evidence, retained separately from user-authored metadata.
 * These names are the stored format; changing them requires a data migration. */
export const WIKI_REPORT_FIELDS = {
  automationId: "producer_automation_id",
  runId: "producer_run_id",
  period: "observation_period",
  sources: "source_refs",
  legacyNote: "provenance_note"
} as const

/** Only producer-owned fields are protected; ordinary notes can reuse a key. */
export function isWikiProducerField({
  metadata,
  key
}: {
  readonly metadata: Readonly<Record<string, JsonValue>>
  readonly key: string
}): boolean {
  const producer = metadata[WIKI_REPORT_FIELDS.automationId]
  return (
    typeof producer === "string" &&
    producer.length > 0 &&
    Object.values(WIKI_REPORT_FIELDS).some((field) => field === key)
  )
}

/** A normal metadata edit cannot replace its producer's retained evidence. */
export function wikiProducerFieldsUnchanged({
  before,
  after
}: {
  readonly before: Readonly<Record<string, JsonValue>>
  readonly after: Readonly<Record<string, JsonValue>>
}): boolean {
  return Object.values(WIKI_REPORT_FIELDS).every(
    (key) =>
      !isWikiProducerField({ metadata: before, key }) ||
      JSON.stringify(before[key]) === JSON.stringify(after[key])
  )
}

export type WikiResourceState = "active" | "archived"
/** A page as a commit left it (`after`), or as it was before an upkeep commit that is still its
 *  latest change (`before`, the undo of a Wiki Maintenance change). */
export type WikiRestoreSide = "after" | "before"

export const WIKI_PAGE_LIFECYCLE = { active: "active", redirect: "redirect" } as const
export const WIKI_EXCERPT = { blank: "blank", text: "text" } as const
export const WIKI_MOMENT = { unrecorded: "unrecorded", at: "at" } as const
export const WIKI_PAGE_LIST = { empty: "empty", snapshot: "snapshot" } as const
export const WIKI_NEXT_PAGE = { end: "end", more: "more" } as const
export const WIKI_LIST_START = { first: "first", after: "after" } as const
export const WIKI_COMMIT_PARENT = { root: "root", commit: "commit" } as const
export const WIKI_CHANGE_ACTION = {
  create: "create",
  update: "update",
  move: "move",
  archive: "archive",
  restore: "restore"
} as const
export const WIKI_DIFF_BASE = { empty: "empty", version: "version" } as const
export const WIKI_LINK_STATUS = { resolved: "resolved", unresolved: "unresolved" } as const
export const WIKI_LINK_ANCHOR = { page: "page", heading: "heading" } as const
export const WIKI_LINK_LABEL = { target: "target", alias: "alias" } as const
export const WIKI_CHAT_NAME = { untitled: "untitled", named: "named" } as const
export const WIKI_CHAT_SPACE = { loose: "loose", space: "space" } as const
export const WIKI_CHAT_SOURCE = { cited: "cited", saved: "saved" } as const
export const WIKI_CHAT_SUMMARY = { pending: "pending", summarized: "summarized" } as const
export const WIKI_CONFLICT_CURRENT = { unavailable: "unavailable", page: "page" } as const

export type WikiPageLifecycle =
  | { readonly kind: "active" }
  | { readonly kind: "redirect"; readonly to: string }

export type WikiExcerpt =
  | { readonly kind: "blank" }
  | { readonly kind: "text"; readonly text: string }

export type WikiMoment =
  | { readonly kind: "unrecorded" }
  | { readonly kind: "at"; readonly at: string }

export interface WikiPageSummary extends JsonRecord {
  readonly pageId: string
  readonly path: string
  readonly resourceState: WikiResourceState
  readonly title: string
  readonly excerpt: WikiExcerpt
  readonly aliases: ReadonlyArray<string>
  readonly lifecycle: WikiPageLifecycle
  readonly metadata: Readonly<Record<string, JsonValue>>
  readonly version: string
  readonly repositoryHead: string
  readonly created: WikiMoment
  readonly updated: WikiMoment
}

export interface WikiPage extends WikiPageSummary {
  readonly content: string
}

export type WikiNextPage =
  | { readonly kind: "end" }
  | { readonly kind: "more"; readonly cursor: string }

export type WikiPagePage =
  | { readonly kind: "empty" }
  | {
      readonly kind: "snapshot"
      readonly repositoryHead: string
      readonly pages: ReadonlyArray<WikiPageSummary>
      readonly next: WikiNextPage
    }

/** The compact acknowledgement returned by archive. */
export interface WikiArchiveResponse extends JsonRecord {
  readonly pageId: string
  readonly path: string
  readonly resourceState: "archived"
  readonly version: string
  readonly repositoryHead: string
}

export interface WikiResourceVersion extends JsonRecord {
  readonly resourceId: string
  readonly path: string
  readonly state: WikiResourceState
  readonly versionId: string
}

export type WikiEditAction = "update" | "move" | "archive" | "restore"

export type WikiHistoryChange =
  | { readonly action: "create"; readonly after: WikiResourceVersion }
  | {
      readonly action: WikiEditAction
      readonly before: WikiResourceVersion
      readonly after: WikiResourceVersion
    }

export type WikiCommitParent =
  | { readonly kind: "root" }
  | { readonly kind: "commit"; readonly id: string }

export interface WikiHistoryCommit extends JsonRecord {
  /** Counts for the requested page, excluding patch headers and context. */
  readonly addedLines: number
  readonly removedLines: number
  readonly commitId: string
  readonly parent: WikiCommitParent
  readonly actor: string
  readonly origin: string
  readonly reason: string
  readonly timestamp: string
  readonly changes: ReadonlyArray<WikiHistoryChange>
  /** The sides of this commit a history restore accepts now and that would change the page. */
  readonly restorable: ReadonlyArray<WikiRestoreSide>
}

export interface WikiPageHistoryResponse extends JsonRecord {
  readonly pageId: string
  readonly repositoryHead: string
  readonly commits: ReadonlyArray<WikiHistoryCommit>
}

export type WikiDiffBase =
  | { readonly kind: "empty" }
  | { readonly kind: "version"; readonly version: string }

export interface WikiPageDiff extends JsonRecord {
  readonly offset: number
  readonly endOffset: number
  readonly base: WikiDiffBase
  readonly target: string
  readonly hasMore: boolean
  readonly unifiedDiff: string
}

/** One page's change between two of its versions, bounded: `hasMore` when
 *  the diff goes on past what was returned. */
export interface WikiVersionDiff extends JsonRecord {
  readonly hasMore: boolean
  readonly unifiedDiff: string
}

export type WikiLinkStatus = "resolved" | "unresolved"

export type WikiLinkAnchor =
  | { readonly kind: "page" }
  | { readonly kind: "heading"; readonly heading: string }

export type WikiLinkLabel =
  | { readonly kind: "target" }
  | { readonly kind: "alias"; readonly alias: string }

interface WikiLinkFields extends JsonRecord {
  readonly sourcePageId: string
  readonly target: string
  readonly anchor: WikiLinkAnchor
  readonly label: WikiLinkLabel
}

export type WikiLink =
  | (WikiLinkFields & { readonly status: "resolved"; readonly targetPageId: string })
  | (WikiLinkFields & { readonly status: "unresolved" })

export type WikiChatName =
  | { readonly kind: "untitled" }
  | { readonly kind: "named"; readonly name: string }

export type WikiChatSpace =
  | { readonly kind: "loose" }
  | { readonly kind: "space"; readonly id: string; readonly name: string }

export type WikiChatSource =
  | { readonly kind: "cited" }
  | { readonly kind: "saved"; readonly at: string }

export type WikiChatSummary =
  | { readonly kind: "pending" }
  | { readonly kind: "summarized"; readonly text: string }

/** One of the user's chats a page was saved from. */
export interface WikiPageChat extends JsonRecord {
  readonly sessionRef: string
  readonly name: WikiChatName
  readonly space: WikiChatSpace
  readonly source: WikiChatSource
  readonly summary: WikiChatSummary
}

export interface WikiPageLinks extends JsonRecord {
  readonly pageId: string
  readonly repositoryHead: string
  readonly outgoing: ReadonlyArray<WikiLink>
  readonly backlinks: ReadonlyArray<WikiLink>
  /** The chats the page came from, newest save first. */
  readonly cameFrom: ReadonlyArray<WikiPageChat>
}

/** The pages and links a rename changes. */
export interface WikiRenamePlan extends JsonRecord {
  readonly oldPath: string
  readonly newPath: string
  readonly oldTitle: string
  readonly newTitle: string
  readonly linkCount: number
  readonly pageCount: number
}

export type WikiConflictCurrent =
  | { readonly kind: "unavailable" }
  | { readonly kind: "page"; readonly version: string; readonly content: string }

/** Structured detail returned for a stale Wiki write. */
export interface WikiRevisionConflict extends JsonRecord {
  readonly error: "page_revision_conflict"
  readonly message: string
  readonly current: WikiConflictCurrent
}

export interface WikiPageGuard extends JsonRecord {
  readonly pageId: string
  readonly version: string
  readonly repositoryHead: string
}

export interface RenameWikiPageInput {
  readonly newPath: string
  readonly newTitle: string
}

export interface WikiHistoryRouteOptions {
  readonly limit: number
}

export interface WikiDiffRouteOptions {
  readonly base: WikiDiffBase
  readonly target: string
  readonly offset: number
  readonly limit: number
}

/** Two version ids of one page; `before` is "absent" for a created page. */
export interface WikiVersionDiffRouteOptions {
  readonly before: string
  readonly after: string
}

export type WikiListStart =
  | { readonly kind: "first" }
  | { readonly kind: "after"; readonly cursor: string }

export interface WikiPageListOptions {
  readonly includeRedirects: boolean
  readonly limit: number
  readonly start: WikiListStart
}
