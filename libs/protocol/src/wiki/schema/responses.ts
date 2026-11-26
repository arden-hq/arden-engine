import { Schema } from "effect"
import {
  WIKI_CHANGE_ACTION,
  WIKI_CHAT_NAME,
  WIKI_CHAT_SOURCE,
  WIKI_CHAT_SPACE,
  WIKI_CHAT_SUMMARY,
  WIKI_COMMIT_PARENT,
  WIKI_CONFLICT_CURRENT,
  WIKI_LINK_ANCHOR,
  WIKI_LINK_LABEL,
  WIKI_LINK_STATUS,
  WIKI_NEXT_PAGE,
  WIKI_PAGE_LIST,
  type WikiArchiveResponse,
  type WikiHistoryChange,
  type WikiHistoryCommit,
  type WikiLink,
  type WikiPage,
  type WikiPageDiff,
  type WikiVersionDiff,
  type WikiPageHistoryResponse,
  type WikiPageLinks,
  type WikiPagePage,
  type WikiPageSummary,
  type WikiRenamePlan,
  type WikiResourceVersion,
  type WikiRevisionConflict
} from "../contracts.js"
import { IsoDateTimeStringSchema, NonNegativeIntSchema, withExtras } from "../../common/schema.js"
import {
  pageFields,
  boundedText,
  WikiDiffBaseSchema,
  WikiPageIdSchema,
  WikiRevisionIdSchema,
  WikiResourceStateSchema,
  WikiRestoreSideSchema
} from "./shared.js"

export const WikiPageSummarySchema = withExtras(pageFields)

export const WikiPageSchema = withExtras({
  ...pageFields,
  content: Schema.String
})

const WikiNextPageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_NEXT_PAGE.end) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_NEXT_PAGE.more), cursor: boundedText(1_024) })
])

export const WikiPagePageSchema = Schema.Union([
  withExtras({ kind: Schema.Literal(WIKI_PAGE_LIST.empty) }),
  withExtras({
    kind: Schema.Literal(WIKI_PAGE_LIST.snapshot),
    repository_head: WikiRevisionIdSchema,
    pages: Schema.Array(WikiPageSummarySchema),
    next: WikiNextPageSchema
  }).check(
    Schema.makeFilter((page) =>
      page.pages.every((summary) => summary.repository_head === page.repository_head)
        ? undefined
        : { path: ["pages"], issue: "must belong to the declared repository snapshot" }
    )
  )
])

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

export const WikiHistoryChangeSchema = Schema.Union([
  withExtras({
    action: Schema.Literal(WIKI_CHANGE_ACTION.create),
    after: WikiResourceVersionSchema
  }),
  withExtras({
    action: Schema.Literals([
      WIKI_CHANGE_ACTION.update,
      WIKI_CHANGE_ACTION.move,
      WIKI_CHANGE_ACTION.archive,
      WIKI_CHANGE_ACTION.restore
    ]),
    before: WikiResourceVersionSchema,
    after: WikiResourceVersionSchema
  })
])

const WikiCommitParentSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_COMMIT_PARENT.root) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_COMMIT_PARENT.commit), id: WikiRevisionIdSchema })
])

export const WikiHistoryCommitSchema = withExtras({
  added_lines: NonNegativeIntSchema,
  removed_lines: NonNegativeIntSchema,
  commit_id: WikiRevisionIdSchema,
  parent: WikiCommitParentSchema,
  actor: boundedText(1_024),
  origin: boundedText(1_024),
  reason: Schema.String.check(Schema.isMaxLength(16_384)),
  timestamp: IsoDateTimeStringSchema,
  changes: Schema.Array(WikiHistoryChangeSchema),
  restorable: Schema.Array(WikiRestoreSideSchema)
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
  base: WikiDiffBaseSchema,
  target: WikiRevisionIdSchema,
  diff: WikiResourceDiffPageSchema
})

const WikiLinkAnchorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_LINK_ANCHOR.page) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_LINK_ANCHOR.heading), heading: Schema.String })
])

const WikiLinkLabelSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_LINK_LABEL.target) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_LINK_LABEL.alias), alias: Schema.String })
])

const linkFields = {
  source_page_id: WikiPageIdSchema,
  target: Schema.String,
  anchor: WikiLinkAnchorSchema,
  label: WikiLinkLabelSchema
} as const

export const WikiLinkSchema = Schema.Union([
  withExtras({
    ...linkFields,
    status: Schema.Literal(WIKI_LINK_STATUS.resolved),
    target_page_id: WikiPageIdSchema
  }),
  withExtras({ ...linkFields, status: Schema.Literal(WIKI_LINK_STATUS.unresolved) })
])

const WikiPageChatSchema = withExtras({
  session_ref: Schema.NonEmptyString,
  name: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WIKI_CHAT_NAME.untitled) }),
    Schema.Struct({ kind: Schema.Literal(WIKI_CHAT_NAME.named), name: Schema.String })
  ]),
  space: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WIKI_CHAT_SPACE.loose) }),
    Schema.Struct({
      kind: Schema.Literal(WIKI_CHAT_SPACE.space),
      id: Schema.String,
      name: Schema.String
    })
  ]),
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WIKI_CHAT_SOURCE.cited) }),
    Schema.Struct({ kind: Schema.Literal(WIKI_CHAT_SOURCE.saved), at: Schema.String })
  ]),
  summary: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WIKI_CHAT_SUMMARY.pending) }),
    Schema.Struct({ kind: Schema.Literal(WIKI_CHAT_SUMMARY.summarized), text: Schema.String })
  ])
})

export const WikiPageLinksSchema = withExtras({
  page_id: WikiPageIdSchema,
  repository_head: WikiRevisionIdSchema,
  outgoing: Schema.Array(WikiLinkSchema),
  backlinks: Schema.Array(WikiLinkSchema),
  came_from: Schema.Array(WikiPageChatSchema)
})

export const WikiRenamePlanSchema = withExtras({
  old_path: boundedText(4_096),
  new_path: boundedText(4_096),
  old_title: boundedText(4_096),
  new_title: boundedText(4_096),
  link_count: NonNegativeIntSchema,
  page_count: NonNegativeIntSchema
})

export const WikiRevisionConflictDetailSchema = withExtras({
  error: Schema.Literal("page_revision_conflict"),
  message: Schema.String,
  current: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WIKI_CONFLICT_CURRENT.unavailable) }),
    Schema.Struct({
      kind: Schema.Literal(WIKI_CONFLICT_CURRENT.page),
      version: WikiRevisionIdSchema,
      content: Schema.String
    })
  ])
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
    metadata,
    version,
    repository_head,
    created,
    updated,
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
    metadata,
    version,
    repositoryHead: repository_head,
    created,
    updated
  }
}

export const toWikiPage = (page: typeof WikiPageSchema.Type): WikiPage => ({
  ...mapPageSummary(page),
  content: page.content
})

const mapResourceVersion = (
  version: typeof WikiResourceVersionSchema.Type
): WikiResourceVersion => {
  const { resource_id, path, blob_id: _blobId, state, version_id, ...extras } = version
  return { ...extras, resourceId: resource_id, path, state, versionId: version_id }
}

const mapHistoryChange = (change: typeof WikiHistoryChangeSchema.Type): WikiHistoryChange =>
  change.action === WIKI_CHANGE_ACTION.create
    ? { action: change.action, after: mapResourceVersion(change.after) }
    : {
        action: change.action,
        before: mapResourceVersion(change.before),
        after: mapResourceVersion(change.after)
      }

const mapHistoryCommit = (commit: typeof WikiHistoryCommitSchema.Type): WikiHistoryCommit => {
  const {
    commit_id,
    parent,
    added_lines,
    removed_lines,
    tree_id: _treeId,
    actor,
    origin,
    reason,
    timestamp,
    changes,
    restorable,
    ...extras
  } = commit
  return {
    ...extras,
    addedLines: added_lines,
    removedLines: removed_lines,
    commitId: commit_id,
    parent,
    actor,
    origin,
    reason,
    timestamp,
    changes: changes.map(mapHistoryChange),
    restorable
  }
}

const mapLink = (link: typeof WikiLinkSchema.Type): WikiLink => {
  if (link.status === WIKI_LINK_STATUS.resolved) {
    const { source_page_id, target_page_id, ...rest } = link
    return { ...rest, sourcePageId: source_page_id, targetPageId: target_page_id }
  }
  const { source_page_id, ...rest } = link
  return { ...rest, sourcePageId: source_page_id }
}

export const toWikiRenamePlan = ({
  old_path,
  new_path,
  old_title,
  new_title,
  link_count,
  page_count,
  ...extras
}: typeof WikiRenamePlanSchema.Type): WikiRenamePlan => ({
  ...extras,
  oldPath: old_path,
  newPath: new_path,
  oldTitle: old_title,
  newTitle: new_title,
  linkCount: link_count,
  pageCount: page_count
})

export const toWikiPagePage = (page: typeof WikiPagePageSchema.Type): WikiPagePage =>
  page.kind === WIKI_PAGE_LIST.empty
    ? { kind: page.kind }
    : {
        kind: page.kind,
        repositoryHead: page.repository_head,
        pages: page.pages.map(mapPageSummary),
        next: page.next
      }

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
  cameFrom: came_from.map(({ session_ref, ...chat }) => ({ ...chat, sessionRef: session_ref }))
})

const isRevisionConflictEnvelope = Schema.is(WikiRevisionConflictEnvelopeSchema)

export const toWikiRevisionConflict = (
  response: typeof WikiRevisionConflictResponseSchema.Type
): WikiRevisionConflict => (isRevisionConflictEnvelope(response) ? response.detail : response)
