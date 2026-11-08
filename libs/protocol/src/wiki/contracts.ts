import type { JsonRecord, JsonValue } from "../common/json.js"

export const WIKI_PAGE_DEFAULT_LIMIT = 100
export const WIKI_PAGE_MAX_LIMIT = 100

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
export type WikiPageLifecycle = "active" | "redirect"

/** Public page projection. Blob and tree storage identities are not exposed. */
export interface WikiPageSummary extends JsonRecord {
  readonly pageId: string
  readonly path: string
  readonly resourceState: WikiResourceState
  readonly title: string
  readonly excerpt: string | null
  readonly aliases: ReadonlyArray<string>
  readonly lifecycle: WikiPageLifecycle
  readonly redirectTo: string | null
  readonly metadata: Readonly<Record<string, JsonValue>>
  readonly version: string
  /** Null only for the derived health page before the first repository commit. */
  readonly repositoryHead: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export interface WikiPage extends WikiPageSummary {
  readonly content: string
}

export interface WikiPagePage extends JsonRecord {
  /** Null is valid for an empty or derived-only repository snapshot. */
  readonly repositoryHead: string | null
  readonly pages: ReadonlyArray<WikiPageSummary>
  readonly nextCursor: string | null
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

export interface WikiHistoryChange extends JsonRecord {
  readonly action: string
  readonly before: WikiResourceVersion | null
  readonly after: WikiResourceVersion | null
}

export interface WikiHistoryCommit extends JsonRecord {
  /** Counts for the requested page, excluding patch headers and context. */
  readonly addedLines: number
  readonly removedLines: number
  readonly commitId: string
  readonly parentId: string | null
  readonly actor: string
  readonly origin: string
  readonly reason: string
  readonly timestamp: string
  readonly changes: ReadonlyArray<WikiHistoryChange>
}

export interface WikiPageHistoryResponse extends JsonRecord {
  readonly pageId: string
  readonly repositoryHead: string
  readonly commits: ReadonlyArray<WikiHistoryCommit>
}

/** Public diff text and pagination cursor returned by the revision endpoint. */
export interface WikiPageDiff extends JsonRecord {
  readonly offset: number
  readonly endOffset: number
  readonly base: string | null
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

export interface WikiLink extends JsonRecord {
  readonly sourcePageId: string
  readonly target: string
  readonly alias: string | null
  readonly heading: string | null
  readonly status: WikiLinkStatus
  readonly targetPageId: string | null
}

/** One of the user's chats a page was saved from. */
export interface WikiPageChat extends JsonRecord {
  readonly sessionRef: string
  readonly name: string | null
  /** The Space the chat belongs to; null when it names none. */
  readonly spaceId: string | null
  readonly spaceName: string | null
  /** When that chat last saved the page; null for a chat the page only cites. */
  readonly savedAt: string | null
  /** What the chat covered, from its Chat summary; null until it has one. */
  readonly summary: string | null
}

export interface WikiPageLinks extends JsonRecord {
  readonly pageId: string
  readonly repositoryHead: string | null
  readonly outgoing: ReadonlyArray<WikiLink>
  readonly backlinks: ReadonlyArray<WikiLink>
  /** The chats the page came from, newest save first. */
  readonly cameFrom: ReadonlyArray<WikiPageChat>
}

export type WikiRenameApprovalStatus = "pending" | "applying" | "accepted" | "rejected"

export interface WikiRenameApproval extends JsonRecord {
  readonly approvalId: string
  readonly oldPath: string
  readonly newPath: string
  readonly oldTitle: string
  readonly newTitle: string
  readonly linkCount: number
  readonly pageCount: number
  readonly status: WikiRenameApprovalStatus
  readonly createdAt: string
  readonly resolution: string | null
}

/** Structured detail returned for a stale Wiki write. */
export interface WikiRevisionConflict extends JsonRecord {
  readonly error: "page_revision_conflict"
  readonly message: string
  readonly currentContent?: string
  /** The current page version, not the internal revision field name. */
  readonly currentVersion?: string
  readonly currentHead?: string | null
}

/** Minimal public guard accepted by mutations. A null head is rejected at runtime. */
export interface WikiPageGuard extends JsonRecord {
  readonly pageId: string
  readonly version: string
  readonly repositoryHead: string | null
}

export interface CreateWikiPageInput {
  readonly path: string
  readonly title: string
  readonly body?: string
  readonly pageId?: string
  readonly aliases?: ReadonlyArray<string>
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export interface RenameWikiPageInput {
  readonly newPath: string
  readonly newTitle: string
}

export interface WikiHistoryRouteOptions {
  readonly limit?: number
}

export interface WikiDiffRouteOptions {
  readonly base?: string | null
  readonly target?: string | null
  readonly offset?: number
  readonly limit?: number
  readonly tail?: boolean
}

/** Two version ids of one page; `before` is "absent" for a created page. */
export interface WikiVersionDiffRouteOptions {
  readonly before: string
  readonly after: string
}

export interface WikiPageListOptions {
  readonly includeRedirects?: boolean
  readonly limit?: number
  readonly cursor?: string
}
