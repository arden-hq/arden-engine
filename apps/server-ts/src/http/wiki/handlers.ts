import { QUERY_BOOLEAN } from "@arden-hq/protocol/common"
import {
  WIKI_CHANGE_ACTION,
  WIKI_CHAT_NAME,
  WIKI_CHAT_SOURCE,
  WIKI_CHAT_SPACE,
  WIKI_CHAT_SUMMARY,
  WIKI_CONFLICT_CURRENT,
  WIKI_DIFF_BASE,
  WIKI_LINK_STATUS,
  WIKI_LIST_START,
  WIKI_PAGE_LIST,
  WIKI_RESTORE_SIDE,
  type WikiHistoryChange,
  type WikiLink,
  type WikiPage,
  type WikiPageSummary,
  type WikiRenamePlan,
  type WikiResourceVersion
} from "@arden-hq/protocol/wiki"
import type { WikiRenameRequestSchema } from "@arden-hq/protocol/effect/wiki"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { pageCameFrom } from "../../memory/discussed-in.js"
import { STORE_REASON } from "../../persistence/errors.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { SummaryStore } from "../../persistence/summaries/store.js"
import { SessionQueries } from "../../persistence/sessions/queries.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../../wiki/authority.js"
import { ownerInApp } from "../../wiki/origin.js"
import { OWNER_RENAME } from "../../wiki/rename.js"
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
  metadata: page.metadata,
  version: page.version,
  repository_head: page.repositoryHead,
  created: page.created,
  updated: page.updated
})

const pageDetail = (page: WikiPage) => ({
  ...pageSummary(page),
  content: page.content
})

const version = (value: WikiResourceVersion) => ({
  resource_id: value.resourceId,
  path: value.path,
  state: value.state,
  version_id: value.versionId
})

const historyChange = (change: WikiHistoryChange) =>
  change.action === WIKI_CHANGE_ACTION.create
    ? { action: change.action, after: version(change.after) }
    : { action: change.action, before: version(change.before), after: version(change.after) }

const link = (value: WikiLink) => {
  const fields = {
    source_page_id: value.sourcePageId,
    target: value.target,
    anchor: value.anchor,
    label: value.label
  }
  return value.status === WIKI_LINK_STATUS.resolved
    ? { ...fields, status: value.status, target_page_id: value.targetPageId }
    : { ...fields, status: value.status }
}

const renamePlan = (plan: WikiRenamePlan) => ({
  old_path: plan.oldPath,
  new_path: plan.newPath,
  old_title: plan.oldTitle,
  new_title: plan.newTitle,
  link_count: plan.linkCount,
  page_count: plan.pageCount
})

const renameInput = (payload: typeof WikiRenameRequestSchema.Type) => ({
  pageId: payload.page_id,
  newPath: payload.new_path,
  newTitle: payload.new_title,
  expectedVersion: payload.expected_version,
  expectedHead: payload.expected_head,
  authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
  commit: OWNER_RENAME
})

const conflictError = (error: WikiError) => ({
  detail: {
    error: "page_revision_conflict" as const,
    message: error.message,
    current:
      error.currentVersion === undefined || error.currentContent === undefined
        ? { kind: WIKI_CONFLICT_CURRENT.unavailable }
        : {
            kind: WIKI_CONFLICT_CURRENT.page,
            version: error.currentVersion,
            content: error.currentContent
          }
  }
})

const writeError = (error: WikiError) => {
  return error.reason === STORE_REASON.conflict ? conflictError(error) : wikiErrorToHttp(error)
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
            includeRedirects: query.include_redirects === QUERY_BOOLEAN.true,
            limit: query.limit,
            start:
              query.start === WIKI_LIST_START.after
                ? { kind: query.start, cursor: query.cursor }
                : { kind: query.start }
          })
          .pipe(
            Effect.map((listed) =>
              listed.kind === WIKI_PAGE_LIST.empty
                ? { kind: listed.kind }
                : {
                    kind: listed.kind,
                    repository_head: listed.repositoryHead,
                    pages: listed.pages.map(pageSummary),
                    next: listed.next
                  }
            ),
            Effect.mapError(wikiErrorToHttp)
          )
      )
      .handle("read", ({ params }) =>
        wiki.read(params.pageId).pipe(Effect.map(pageDetail), Effect.mapError(wikiErrorToHttp))
      )
      .handle("update", ({ params, payload }) =>
        wiki
          .update({
            edits: [
              {
                pageId: params.pageId,
                content: payload.content,
                expectedVersion: payload.expected_version
              }
            ],
            expectedHead: payload.expected_head,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: ownerInApp("update wiki page")
          })
          .pipe(
            Effect.map(([page]) => pageDetail(page)),
            Effect.mapError(writeError)
          )
      )
      .handle("archive", ({ params, payload }) =>
        wiki
          .archive({
            pageId: params.pageId,
            expectedVersion: payload.expected_version,
            expectedHead: payload.expected_head,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: ownerInApp("archive wiki page")
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
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: ownerInApp("restore archived wiki page")
          })
          .pipe(Effect.map(pageDetail), Effect.mapError(writeError))
      )
      .handle("history", ({ params, query }) =>
        wiki.history(params.pageId, { limit: query.limit }).pipe(
          Effect.map((result) => ({
            page_id: result.pageId,
            repository_head: result.repositoryHead,
            commits: result.commits.map((commit) => ({
              added_lines: commit.addedLines,
              removed_lines: commit.removedLines,
              commit_id: commit.commitId,
              parent: commit.parent,
              actor: commit.actor,
              origin: commit.origin,
              reason: commit.reason,
              timestamp: commit.timestamp,
              changes: commit.changes.map(historyChange),
              restorable: commit.restorable
            }))
          })),
          Effect.mapError(wikiErrorToHttp)
        )
      )
      .handle("restoreHistory", ({ params, payload }) =>
        wiki
          .restore({
            pageId: params.pageId,
            version: { commitId: params.commitId, side: payload.side },
            expectedVersion: payload.expected_version,
            expectedHead: payload.expected_head,
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: ownerInApp(
              payload.side === WIKI_RESTORE_SIDE.after
                ? `restore wiki page to its version of commit ${params.commitId}`
                : `restore Maintenance commit ${params.commitId}`,
              "desktop.restore"
            )
          })
          .pipe(Effect.map(pageDetail), Effect.mapError(writeError))
      )
      .handle("diff", ({ params, query }) =>
        wiki
          .diff(params.pageId, {
            base:
              query.from === WIKI_DIFF_BASE.version
                ? { kind: query.from, version: query.base }
                : { kind: query.from },
            target: query.target,
            offset: query.offset,
            limit: query.limit
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
              name:
                chat.name === null
                  ? { kind: WIKI_CHAT_NAME.untitled }
                  : { kind: WIKI_CHAT_NAME.named, name: chat.name },
              space:
                chat.spaceId === null || chat.spaceName === null
                  ? { kind: WIKI_CHAT_SPACE.loose }
                  : { kind: WIKI_CHAT_SPACE.space, id: chat.spaceId, name: chat.spaceName },
              source:
                chat.savedAt === null
                  ? { kind: WIKI_CHAT_SOURCE.cited }
                  : { kind: WIKI_CHAT_SOURCE.saved, at: chat.savedAt },
              summary:
                chat.summary === null
                  ? { kind: WIKI_CHAT_SUMMARY.pending }
                  : { kind: WIKI_CHAT_SUMMARY.summarized, text: chat.summary }
            }))
          })),
          Effect.mapError(wikiErrorToHttp)
        )
      )
      .handle("planRename", ({ payload }) =>
        wiki
          .planRename(renameInput(payload))
          .pipe(Effect.map(renamePlan), Effect.mapError(writeError))
      )
      .handle("rename", ({ payload }) =>
        wiki.rename(renameInput(payload)).pipe(Effect.map(renamePlan), Effect.mapError(writeError))
      )
  })
)
