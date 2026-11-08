import { Schema } from "effect"
import type {
  WikiArchiveResponse,
  WikiHistoryChange,
  WikiHistoryCommit,
  WikiLink,
  WikiPage,
  WikiPageDiff,
  WikiVersionDiff,
  WikiPageHistoryResponse,
  WikiPageLinks,
  WikiPagePage,
  WikiPageSummary,
  WikiRenameApproval,
  WikiResourceVersion,
  WikiRevisionConflict
} from "../contracts.js"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../../common/schema.js"
import {
  nullableRevisionIdSchema,
  pageFields,
  boundedText,
  WikilinkNodeSchema,
  WikiPageIdSchema,
  WikiRevisionIdSchema,
  WikiResourceStateSchema,
  trimmedText
} from "./shared.js"

/** Wire schemas retain additive fields; mapping removes known storage-only keys. */
export const WikiPageSummarySchema = withExtras({
  ...pageFields,
  content: Schema.optionalKey(Schema.String)
}).check(
  Schema.makeFilter((page) =>
    page.repository_head !== null || (page.page_id === "health" && page.path === "health.md")
      ? undefined
      : { path: ["repository_head"], issue: "can be null only for the derived health page" }
  )
)

export const WikiPageSchema = withExtras({
  ...pageFields,
  content: Schema.String
}).check(
  Schema.makeFilter((page) =>
    page.repository_head !== null || (page.page_id === "health" && page.path === "health.md")
      ? undefined
      : { path: ["repository_head"], issue: "can be null only for the derived health page" }
  )
)

export const WikiPagePageSchema = withExtras({
  repository_head: Schema.NullOr(WikiRevisionIdSchema),
  pages: Schema.Array(WikiPageSummarySchema),
  next_cursor: Schema.NullOr(boundedText(1_024))
}).check(
  Schema.makeFilter((page) => {
    return page.pages.every((summary) => summary.repository_head === page.repository_head)
      ? undefined
      : { path: ["pages"], issue: "must belong to the declared repository snapshot" }
  })
)

export const WikiArchiveResponseSchema = withExtras({
  page_id: WikiPageIdSchema,
  path: boundedText(4_096),
  resource_state: Schema.Literal("archived"),
  version: WikiRevisionIdSchema,
  repository_head: WikiRevisionIdSchema
})

export const WikiResourceVersionSchema = withExtras({
  resource_id: WikiPageIdSchema,
  path: boundedText(4_096),
  state: WikiResourceStateSchema,
  version_id: WikiRevisionIdSchema
})

export const WikiHistoryChangeSchema = withExtras({
  action: boundedText(128),
  before: Schema.NullOr(WikiResourceVersionSchema),
  after: Schema.NullOr(WikiResourceVersionSchema)
})

export const WikiHistoryCommitSchema = withExtras({
  added_lines: NonNegativeIntSchema,
  removed_lines: NonNegativeIntSchema,
  commit_id: WikiRevisionIdSchema,
  parent_id: nullableRevisionIdSchema,
  actor: boundedText(1_024),
  origin: boundedText(1_024),
  reason: Schema.String.check(Schema.isMaxLength(16_384)),
  timestamp: IsoDateTimeStringSchema,
  changes: Schema.Array(WikiHistoryChangeSchema)
})

export const WikiPageHistoryResponseSchema = withExtras({
  page_id: WikiPageIdSchema,
  repository_head: WikiRevisionIdSchema,
  commits: Schema.Array(WikiHistoryCommitSchema)
})

export const WikiResourceDiffPageSchema = withExtras({
  offset: NonNegativeIntSchema,
  end_offset: NonNegativeIntSchema,
  has_more: Schema.Boolean,
  unified_diff: Schema.String
}).check(
  Schema.makeFilter((page) =>
    page.end_offset >= page.offset
      ? undefined
      : { path: ["end_offset"], issue: "must not precede offset" }
  )
)

export const WikiPageDiffResponseSchema = withExtras({
  base: nullableRevisionIdSchema,
  target: WikiRevisionIdSchema,
  diff: WikiResourceDiffPageSchema
})

export const WikiLinkSchema = withExtras({
  source_page_id: WikiPageIdSchema,
  node: WikilinkNodeSchema,
  status: Schema.Literals(["resolved", "unresolved"] as const),
  target_page_id: Schema.NullOr(WikiPageIdSchema)
})

const WikiPageChatSchema = withExtras({
  session_ref: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
  space_id: Schema.NullOr(Schema.String),
  space_name: Schema.NullOr(Schema.String),
  saved_at: Schema.NullOr(Schema.String),
  summary: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const WikiPageLinksSchema = withExtras({
  page_id: WikiPageIdSchema,
  repository_head: Schema.NullOr(WikiRevisionIdSchema),
  outgoing: Schema.Array(WikiLinkSchema),
  backlinks: Schema.Array(WikiLinkSchema),
  came_from: Schema.optionalKey(Schema.Array(WikiPageChatSchema))
}).check(
  Schema.makeFilter((report) =>
    report.repository_head !== null || report.page_id === "health"
      ? undefined
      : { path: ["repository_head"], issue: "can be null only for the derived health page" }
  )
)

export const WikiRenameApprovalStatusSchema = Schema.Literals([
  "pending",
  "applying",
  "accepted",
  "rejected"
] as const)

export const WikiRenameApprovalSchema = withExtras({
  approval_id: trimmedText(512),
  old_path: boundedText(4_096),
  new_path: boundedText(4_096),
  old_title: boundedText(4_096),
  new_title: boundedText(4_096),
  link_count: NonNegativeIntSchema,
  page_count: NonNegativeIntSchema,
  status: WikiRenameApprovalStatusSchema,
  created_at: IsoDateTimeStringSchema,
  resolution: Schema.NullOr(Schema.String)
})

export const WikiRenameApprovalListResponseSchema = withExtras({
  approvals: Schema.Array(WikiRenameApprovalSchema)
})

export const WikiRevisionConflictDetailSchema = withExtras({
  error: Schema.Literal("page_revision_conflict"),
  message: Schema.String,
  current_content: Schema.optionalKey(Schema.String),
  current_revision: Schema.optionalKey(WikiRevisionIdSchema),
  current_head: Schema.optionalKey(Schema.NullOr(WikiRevisionIdSchema))
})

export const WikiRevisionConflictEnvelopeSchema = withExtras({
  detail: WikiRevisionConflictDetailSchema
})

export const WikiRevisionConflictResponseSchema = Schema.Union([
  WikiRevisionConflictEnvelopeSchema,
  WikiRevisionConflictDetailSchema
])

const mapPageSummary = (
  page: typeof WikiPageSummarySchema.Type | typeof WikiPageSchema.Type
): WikiPageSummary => {
  const {
    page_id,
    path,
    resource_state,
    title,
    excerpt,
    aliases,
    lifecycle,
    redirect_to,
    metadata,
    version,
    repository_head,
    created_at,
    updated_at,
    projection_pending: _projectionPending,
    content: _content,
    resource_id: _resourceId,
    version_id: _versionId,
    blob_id: _blobId,
    tree_id: _treeId,
    ...extras
  } = page
  return {
    ...extras,
    pageId: page_id,
    path,
    resourceState: resource_state,
    title,
    excerpt,
    aliases,
    lifecycle,
    redirectTo: redirect_to,
    metadata,
    version,
    repositoryHead: repository_head,
    createdAt: created_at,
    updatedAt: updated_at
  }
}

export const toWikiPage = (page: typeof WikiPageSchema.Type): WikiPage => ({
  ...mapPageSummary(page),
  content: page.content
})

const mapResourceVersion = (
  version: typeof WikiResourceVersionSchema.Type | null
): WikiResourceVersion | null => {
  if (version === null) return null
  const { resource_id, path, blob_id: _blobId, state, version_id, ...extras } = version
  return { ...extras, resourceId: resource_id, path, state, versionId: version_id }
}

const mapHistoryChange = (change: typeof WikiHistoryChangeSchema.Type): WikiHistoryChange => {
  const { action, before, after, ...extras } = change
  return {
    ...extras,
    action,
    before: mapResourceVersion(before),
    after: mapResourceVersion(after)
  }
}

const mapHistoryCommit = (commit: typeof WikiHistoryCommitSchema.Type): WikiHistoryCommit => {
  const {
    commit_id,
    parent_id,
    added_lines,
    removed_lines,
    tree_id: _treeId,
    actor,
    origin,
    reason,
    timestamp,
    changes,
    ...extras
  } = commit
  return {
    ...extras,
    addedLines: added_lines,
    removedLines: removed_lines,
    commitId: commit_id,
    parentId: parent_id,
    actor,
    origin,
    reason,
    timestamp,
    changes: changes.map(mapHistoryChange)
  }
}

const mapLink = (link: typeof WikiLinkSchema.Type): WikiLink => {
  const { source_page_id, node, status, target_page_id, ...extras } = link
  const { page, fragment } = node
  return {
    ...extras,
    sourcePageId: source_page_id,
    target: fragment ? `${page ?? ""}#${fragment}` : (page ?? ""),
    alias: node.alias,
    heading: fragment,
    status,
    targetPageId: target_page_id
  }
}

export const toWikiRenameApproval = (
  approval: typeof WikiRenameApprovalSchema.Type
): WikiRenameApproval => {
  const {
    approval_id,
    old_path,
    new_path,
    old_title,
    new_title,
    link_count,
    page_count,
    generation: _generation,
    status,
    created_at,
    resolved_at: _resolvedAt,
    commit_id: _commitId,
    resolution,
    replacement_approval_id: _replacementApprovalId,
    request_key: _requestKey,
    request_fingerprint: _requestFingerprint,
    base_head: _baseHead,
    plan_json: _planJson,
    claim_owner: _claimOwner,
    claim_expires_at: _claimExpiresAt,
    ...extras
  } = approval
  return {
    ...extras,
    approvalId: approval_id,
    oldPath: old_path,
    newPath: new_path,
    oldTitle: old_title,
    newTitle: new_title,
    linkCount: link_count,
    pageCount: page_count,
    status,
    createdAt: created_at,
    resolution
  }
}

export const toWikiPagePage = ({
  repository_head,
  pages,
  next_cursor,
  ...extras
}: typeof WikiPagePageSchema.Type): WikiPagePage => ({
  ...extras,
  repositoryHead: repository_head,
  pages: pages.map(mapPageSummary),
  nextCursor: next_cursor
})

export const toWikiArchiveResponse = (
  response: typeof WikiArchiveResponseSchema.Type
): WikiArchiveResponse => {
  const {
    page_id,
    path,
    resource_state,
    version,
    repository_head,
    projection_pending: _projectionPending,
    ...extras
  } = response
  return {
    ...extras,
    pageId: page_id,
    path,
    resourceState: resource_state,
    version,
    repositoryHead: repository_head
  }
}

export const toWikiPageHistoryResponse = ({
  page_id,
  repository_head,
  commits,
  ...extras
}: typeof WikiPageHistoryResponseSchema.Type): WikiPageHistoryResponse => ({
  ...extras,
  pageId: page_id,
  repositoryHead: repository_head,
  commits: commits.map(mapHistoryCommit)
})

export const toWikiVersionDiff = ({
  has_more,
  unified_diff
}: typeof WikiResourceDiffPageSchema.Type): WikiVersionDiff => ({
  hasMore: has_more,
  unifiedDiff: unified_diff
})

export const toWikiPageDiff = ({
  base,
  target,
  diff,
  ...responseExtras
}: typeof WikiPageDiffResponseSchema.Type): WikiPageDiff => {
  const {
    resource_id: _resourceId,
    before: _before,
    after: _after,
    offset,
    end_offset,
    has_more,
    unified_diff,
    ...diffExtras
  } = diff
  return {
    ...responseExtras,
    ...diffExtras,
    base,
    target,
    offset,
    endOffset: end_offset,
    hasMore: has_more,
    unifiedDiff: unified_diff
  }
}

export const toWikiPageLinks = ({
  page_id,
  repository_head,
  outgoing,
  backlinks,
  came_from,
  ...extras
}: typeof WikiPageLinksSchema.Type): WikiPageLinks => ({
  ...extras,
  pageId: page_id,
  repositoryHead: repository_head,
  outgoing: outgoing.map(mapLink),
  backlinks: backlinks.map(mapLink),
  cameFrom: (came_from ?? []).map(
    ({ session_ref, name, space_id, space_name, saved_at, summary, ...chatExtras }) => ({
      ...chatExtras,
      sessionRef: session_ref,
      name,
      spaceId: space_id,
      spaceName: space_name,
      savedAt: saved_at,
      summary: summary ?? null
    })
  )
})

export const toWikiRenameApprovals = ({
  approvals
}: typeof WikiRenameApprovalListResponseSchema.Type): ReadonlyArray<WikiRenameApproval> =>
  approvals.map(toWikiRenameApproval)

const isRevisionConflictEnvelope = Schema.is(WikiRevisionConflictEnvelopeSchema)

export const toWikiRevisionConflict = (
  response: typeof WikiRevisionConflictResponseSchema.Type
): WikiRevisionConflict => {
  const detail = isRevisionConflictEnvelope(response) ? response.detail : response
  const { error, message, current_content, current_revision, current_head, ...extras } = detail
  return {
    ...extras,
    error,
    message,
    ...(current_content === undefined ? {} : { currentContent: current_content }),
    ...(current_revision === undefined ? {} : { currentVersion: current_revision }),
    ...(current_head === undefined ? {} : { currentHead: current_head })
  }
}
