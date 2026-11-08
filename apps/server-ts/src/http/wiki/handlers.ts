import type {
  WikiHistoryChange,
  WikiLink,
  WikiPage,
  WikiPageSummary,
  WikiRenameApproval,
  WikiResourceVersion
} from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { pageCameFrom } from "../../memory/discussed-in.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { SummaryStore } from "../../persistence/summaries/store.js"
import { SessionQueries } from "../../persistence/sessions/queries.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../../wiki/authority.js"
import { WikiError } from "../../wiki/errors.js"
import { Wiki } from "../../wiki/service.js"
import { ArdenApi } from "../api.js"
import { wikiErrorToHttp } from "../errors.js"

const pageSummary = (page: WikiPageSummary) => ({
  page_id: page.pageId,
  path: page.path,
  resource_state: page.resourceState,
  title: page.title,
  excerpt: page.excerpt,
  aliases: page.aliases,
  lifecycle: page.lifecycle,
  redirect_to: page.redirectTo,
  metadata: page.metadata,
  version: page.version,
  repository_head: page.repositoryHead,
  created_at: page.createdAt,
  updated_at: page.updatedAt
})

const pageDetail = (page: WikiPage) => ({
  ...pageSummary(page),
  content: page.content
})

const version = (value: WikiResourceVersion | null) =>
  value === null
    ? null
    : {
        resource_id: value.resourceId,
        path: value.path,
        state: value.state,
        version_id: value.versionId
      }

const historyChange = (change: WikiHistoryChange) => ({
  action: change.action,
  before: version(change.before),
  after: version(change.after)
})

const linkNode = (link: WikiLink) => {
  const page =
    link.heading === null ? link.target : link.target.slice(0, -(link.heading.length + 1))
  return {
    page: page === "" ? null : page,
    fragment: link.heading,
    alias: link.alias
  }
}

const link = (value: WikiLink) => ({
  source_page_id: value.sourcePageId,
  node: linkNode(value),
  status: value.status,
  target_page_id: value.targetPageId
})

const renameApproval = (approval: WikiRenameApproval) => ({
  approval_id: approval.approvalId,
  old_path: approval.oldPath,
  new_path: approval.newPath,
  old_title: approval.oldTitle,
  new_title: approval.newTitle,
  link_count: approval.linkCount,
  page_count: approval.pageCount,
  status: approval.status,
  created_at: approval.createdAt,
  resolution: approval.resolution
})

const conflictError = (error: WikiError) => ({
  detail: {
    error: "page_revision_conflict" as const,
    message: error.message,
    ...(error.currentContent === undefined ? {} : { current_content: error.currentContent }),
    ...(error.currentVersion === undefined ? {} : { current_revision: error.currentVersion }),
    ...(error.currentHead === undefined ? {} : { current_head: error.currentHead })
  }
})

const writeError = (error: WikiError) => {
  return error.reason === "conflict" ? conflictError(error) : wikiErrorToHttp(error)
}

export const WikiHandlers = HttpApiBuilder.group(
  ArdenApi,
  "wiki",
  Effect.fn("WikiHandlers")(function* (handlers) {
    const wiki = yield* Wiki
    const sessions = yield* SessionQueries
    const spaces = yield* SpaceStore
    const summaries = yield* SummaryStore
    return handlers
      .handle("list", ({ query }) =>
        wiki
          .list({
            includeRedirects: query.include_redirects === "true",
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor })
          })
          .pipe(
            Effect.map((snapshot) => ({
              repository_head: snapshot.repositoryHead,
              pages: snapshot.pages.map(pageSummary),
              next_cursor: snapshot.nextCursor
            })),
            Effect.mapError(wikiErrorToHttp)
          )
      )
      .handle("read", ({ params }) =>
        wiki.read(params.pageId).pipe(Effect.map(pageDetail), Effect.mapError(wikiErrorToHttp))
      )
      .handle("update", ({ params, payload }) =>
        wiki
          .update({
            pageId: params.pageId,
            content: payload.content,
            expectedVersion: payload.expected_version,
            expectedHead: payload.expected_head,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY
          })
          .pipe(Effect.map(pageDetail), Effect.mapError(writeError))
      )
      .handle("archive", ({ params, payload }) =>
        wiki
          .archive({
            pageId: params.pageId,
            expectedVersion: payload.expected_version,
            expectedHead: payload.expected_head,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY
          })
          .pipe(
            Effect.map((archived) => ({
              page_id: archived.pageId,
              path: archived.path,
              resource_state: archived.resourceState,
              version: archived.version,
              repository_head: archived.repositoryHead
            })),
            Effect.mapError(writeError)
          )
      )
      .handle("restoreArchived", ({ params, payload }) =>
        wiki
          .restoreArchived({
            pageId: params.pageId,
            expectedVersion: payload.expected_version,
            expectedHead: payload.expected_head,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY
          })
          .pipe(Effect.map(pageDetail), Effect.mapError(writeError))
      )
      .handle("history", ({ params, query }) =>
        wiki
          .history(params.pageId, {
            ...(query.limit === undefined ? {} : { limit: query.limit })
          })
          .pipe(
            Effect.map((result) => ({
              page_id: result.pageId,
              repository_head: result.repositoryHead,
              commits: result.commits.map((commit) => ({
                added_lines: commit.addedLines,
                removed_lines: commit.removedLines,
                commit_id: commit.commitId,
                parent_id: commit.parentId,
                actor: commit.actor,
                origin: commit.origin,
                reason: commit.reason,
                timestamp: commit.timestamp,
                changes: commit.changes.map(historyChange)
              }))
            })),
            Effect.mapError(wikiErrorToHttp)
          )
      )
      .handle("restoreHistory", ({ params, payload }) =>
        wiki
          .restore({
            pageId: params.pageId,
            commitId: params.commitId,
            expectedVersion: payload.expected_version,
            expectedHead: payload.expected_head
          })
          .pipe(Effect.map(pageDetail), Effect.mapError(writeError))
      )
      .handle("diff", ({ params, query }) =>
        wiki
          .diff(params.pageId, {
            ...(query.base === undefined ? {} : { base: query.base }),
            ...(query.target === undefined ? {} : { target: query.target }),
            ...(query.offset === undefined ? {} : { offset: query.offset }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.tail === undefined ? {} : { tail: query.tail === "true" })
          })
          .pipe(
            Effect.map((result) => ({
              base: result.base,
              target: result.target,
              diff: {
                offset: result.offset,
                end_offset: result.endOffset,
                has_more: result.hasMore,
                unified_diff: result.unifiedDiff
              }
            })),
            Effect.mapError(writeError)
          )
      )
      .handle("versionDiff", ({ params, query }) =>
        wiki.versionDiff(params.pageId, query).pipe(
          Effect.map((result) => ({
            offset: 0,
            end_offset: result.unifiedDiff.length,
            has_more: result.hasMore,
            unified_diff: result.unifiedDiff
          })),
          Effect.mapError(wikiErrorToHttp)
        )
      )
      .handle("links", ({ params }) =>
        Effect.all({
          links: wiki.links(params.pageId),
          cameFrom: wiki.read(params.pageId).pipe(
            Effect.flatMap((page) =>
              pageCameFrom({
                wiki,
                sessions,
                spaceName: (spaceId) =>
                  spaces.get(spaceId).pipe(Effect.map((space) => space?.name)),
                pageId: params.pageId,
                body: page.content
              })
            ),
            Effect.flatMap((chats) =>
              summaries.chats(chats.map((chat) => chat.sessionId)).pipe(
                Effect.map((found) =>
                  chats.map((chat) => ({
                    ...chat,
                    summary: found.get(chat.sessionId)?.summary ?? null
                  }))
                )
              )
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Memory page chats unavailable", cause).pipe(Effect.as([]))
            )
          )
        }).pipe(
          Effect.map(({ links: result, cameFrom }) => ({
            page_id: result.pageId,
            repository_head: result.repositoryHead,
            outgoing: result.outgoing.map(link),
            backlinks: result.backlinks.map(link),
            came_from: cameFrom.map((chat) => ({
              session_ref: chat.sessionRef,
              name: chat.name,
              space_id: chat.spaceId,
              space_name: chat.spaceName,
              saved_at: chat.savedAt,
              summary: chat.summary
            }))
          })),
          Effect.mapError(wikiErrorToHttp)
        )
      )
      .handle("listRenameApprovals", () =>
        wiki.listRenameApprovals().pipe(
          Effect.map((approvals) => ({ approvals: approvals.map(renameApproval) })),
          Effect.mapError(wikiErrorToHttp)
        )
      )
      .handle("requestRename", ({ payload }) =>
        wiki
          .requestRename({
            pageId: payload.page_id,
            newPath: payload.new_path,
            newTitle: payload.new_title,
            expectedVersion: payload.expected_version,
            expectedHead: payload.expected_head,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY
          })
          .pipe(Effect.map(renameApproval), Effect.mapError(writeError))
      )
      .handle("acceptRename", ({ params }) =>
        wiki
          .acceptRename({
            approvalId: params.approvalId,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY
          })
          .pipe(Effect.map(renameApproval), Effect.mapError(writeError))
      )
      .handle("rejectRename", ({ params, payload }) =>
        wiki
          .rejectRename(params.approvalId, payload?.resolution)
          .pipe(Effect.map(renameApproval), Effect.mapError(writeError))
      )
  })
)
