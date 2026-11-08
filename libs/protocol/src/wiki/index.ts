import { projectedDecoderFor, runBoundary } from "../common/boundary.js"
import type {
  CreateWikiPageInput,
  RenameWikiPageInput,
  WikiDiffRouteOptions,
  WikiHistoryRouteOptions,
  WikiPageGuard,
  WikiPageListOptions,
  WikiPagePage,
  WikiVersionDiffRouteOptions
} from "./contracts.js"
import {
  WikiArchiveResponseSchema,
  WikiPageDiffResponseSchema,
  WikiPageHistoryResponseSchema,
  WikiResourceDiffPageSchema,
  WikiPageLinksSchema,
  WikiPagePageSchema,
  WikiPageSchema,
  WikiRenameApprovalListResponseSchema,
  WikiRenameApprovalSchema,
  WikiRevisionConflictResponseSchema,
  toWikiArchiveResponse,
  toWikiPage,
  toWikiPageDiff,
  toWikiVersionDiff,
  toWikiPageHistoryResponse,
  toWikiPageLinks,
  toWikiPagePage,
  toWikiRenameApproval,
  toWikiRenameApprovals,
  toWikiRevisionConflict,
  encodeCreateWikiRequestEffect,
  encodeRejectWikiRenameRequestEffect,
  encodeRenameWikiRequestEffect,
  encodeUpdateWikiRequestEffect,
  encodeWikiArchivePathEffect,
  encodeWikiDiffPathEffect,
  encodeWikiVersionDiffPathEffect,
  encodeWikiHistoryPathEffect,
  encodeWikiHistoryRestorePathEffect,
  encodeWikiLinksPathEffect,
  encodeWikiPagePathEffect,
  encodeWikiPagesPathEffect,
  encodeWikiRenameDecisionPathEffect,
  encodeWikiRestoreArchivedPathEffect,
  encodeWikiVersionRequestEffect
} from "./schema.js"

export * from "./contracts.js"

const pageGuard = (page: WikiPageGuard) => ({
  pageId: page.pageId,
  version: page.version,
  repositoryHead: page.repositoryHead
})

/** Plain decoders for the live managed-Wiki HTTP surface. */
export const wikiDecoders = {
  pages: projectedDecoderFor(WikiPagePageSchema, toWikiPagePage, "Invalid Wiki page list"),
  page: projectedDecoderFor(WikiPageSchema, toWikiPage, "Invalid Wiki page"),
  archived: projectedDecoderFor(
    WikiArchiveResponseSchema,
    toWikiArchiveResponse,
    "Invalid Wiki archive response"
  ),
  history: projectedDecoderFor(
    WikiPageHistoryResponseSchema,
    toWikiPageHistoryResponse,
    "Invalid Wiki history"
  ),
  diff: projectedDecoderFor(WikiPageDiffResponseSchema, toWikiPageDiff, "Invalid Wiki diff"),
  versionDiff: projectedDecoderFor(
    WikiResourceDiffPageSchema,
    toWikiVersionDiff,
    "Invalid Wiki version diff"
  ),
  links: projectedDecoderFor(WikiPageLinksSchema, toWikiPageLinks, "Invalid Wiki links"),
  renameApproval: projectedDecoderFor(
    WikiRenameApprovalSchema,
    toWikiRenameApproval,
    "Invalid Wiki rename approval"
  ),
  renameApprovals: projectedDecoderFor(
    WikiRenameApprovalListResponseSchema,
    toWikiRenameApprovals,
    "Invalid Wiki rename approvals"
  ),
  revisionConflict: projectedDecoderFor(
    WikiRevisionConflictResponseSchema,
    toWikiRevisionConflict,
    "Invalid Wiki revision conflict"
  )
} as const

/** Mutation bodies derive revision guards from decoded pages and snapshots. */
export const wikiRequests = {
  create(snapshot: Pick<WikiPagePage, "repositoryHead">, input: CreateWikiPageInput): string {
    return runBoundary(
      encodeCreateWikiRequestEffect({ repositoryHead: snapshot.repositoryHead, input }),
      "Invalid create-Wiki-page request",
      "encode"
    )
  },
  update(page: WikiPageGuard, content: string): string {
    return runBoundary(
      encodeUpdateWikiRequestEffect({ page: pageGuard(page), content }),
      "Invalid Wiki page update",
      "encode"
    )
  },
  archive(page: WikiPageGuard): string {
    return runBoundary(
      encodeWikiVersionRequestEffect(pageGuard(page)),
      "Invalid Wiki archive request",
      "encode"
    )
  },
  /** The guard is the archived version: the archive response itself. */
  restoreArchived(page: WikiPageGuard): string {
    return runBoundary(
      encodeWikiVersionRequestEffect(pageGuard(page)),
      "Invalid Wiki restore request",
      "encode"
    )
  },
  restoreHistory(page: WikiPageGuard): string {
    return runBoundary(
      encodeWikiVersionRequestEffect(pageGuard(page)),
      "Invalid Wiki history-restore request",
      "encode"
    )
  },
  rename(page: WikiPageGuard, input: RenameWikiPageInput): string {
    return runBoundary(
      encodeRenameWikiRequestEffect({ page: pageGuard(page), input }),
      "Invalid Wiki rename request",
      "encode"
    )
  },
  rejectRename(resolution?: string | null): string {
    return runBoundary(
      encodeRejectWikiRenameRequestEffect(resolution === undefined ? {} : { resolution }),
      "Invalid Wiki rename rejection",
      "encode"
    )
  }
} as const

/** Validated paths for the complete consumer-facing Wiki HTTP surface. */
export const wikiRoutes = {
  pages(options: WikiPageListOptions = {}): string {
    return runBoundary(encodeWikiPagesPathEffect(options), "Invalid Wiki pages route", "encode")
  },
  page(pageId: string): string {
    return runBoundary(encodeWikiPagePathEffect(pageId), "Invalid Wiki page route", "encode")
  },
  archive(pageId: string): string {
    return runBoundary(encodeWikiArchivePathEffect(pageId), "Invalid Wiki archive route", "encode")
  },
  restoreArchived(pageId: string): string {
    return runBoundary(
      encodeWikiRestoreArchivedPathEffect(pageId),
      "Invalid Wiki restore route",
      "encode"
    )
  },
  history(pageId: string, options: WikiHistoryRouteOptions = {}): string {
    return runBoundary(
      encodeWikiHistoryPathEffect({ pageId, options }),
      "Invalid Wiki history route",
      "encode"
    )
  },
  historyRestore(pageId: string, commitId: string): string {
    return runBoundary(
      encodeWikiHistoryRestorePathEffect({ pageId, commitId }),
      "Invalid Wiki history-restore route",
      "encode"
    )
  },
  diff(pageId: string, options: WikiDiffRouteOptions = {}): string {
    return runBoundary(
      encodeWikiDiffPathEffect({ pageId, options }),
      "Invalid Wiki diff route",
      "encode"
    )
  },
  versionDiff(pageId: string, options: WikiVersionDiffRouteOptions): string {
    return runBoundary(
      encodeWikiVersionDiffPathEffect({ pageId, options }),
      "Invalid Wiki version-diff route",
      "encode"
    )
  },
  links(pageId: string): string {
    return runBoundary(encodeWikiLinksPathEffect(pageId), "Invalid Wiki links route", "encode")
  },
  renameApprovals: "/admin/wiki/rename-approvals",
  renameDecision(approvalId: string, decision: "accept" | "reject"): string {
    return runBoundary(
      encodeWikiRenameDecisionPathEffect({ approvalId, decision }),
      "Invalid Wiki rename-decision route",
      "encode"
    )
  }
} as const
