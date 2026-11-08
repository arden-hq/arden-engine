import {
  WikiArchiveResponseSchema,
  WikiDiffQuerySchema,
  WikiHistoryQuerySchema,
  WikiPageDiffResponseSchema,
  WikiPageHistoryResponseSchema,
  WikiPageIdSchema,
  WikiPageLinksSchema,
  WikiPageListQuerySchema,
  WikiPagePageSchema,
  WikiPageSchema,
  WikiRenameApprovalListResponseSchema,
  WikiRenameApprovalSchema,
  WikiRenameRejectRequestSchema,
  WikiRenameRequestSchema,
  WikiRevisionConflictEnvelopeSchema,
  WikiResourceDiffPageSchema,
  WikiRevisionIdSchema,
  WikiUpdateRequestSchema,
  WikiVersionDiffRouteOptionsSchema,
  WikiVersionRequestSchema
} from "@arden-hq/protocol/effect/wiki"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

const WikiConflictSchema = Schema.Union([
  WikiRevisionConflictEnvelopeSchema,
  Schema.Struct({ detail: Schema.String })
]).pipe(HttpApiSchema.status("Conflict"))

const wikiWriteErrors = [WikiConflictSchema, ...storeErrors] as const

const WikiRenameApprovalIdSchema = Schema.NonEmptyString.check(Schema.isMaxLength(512))

export class WikiApi extends HttpApiGroup.make("wiki", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/admin/wiki/pages", {
    query: WikiPageListQuerySchema,
    success: WikiPagePageSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("read", "/admin/wiki/pages/:pageId", {
    params: { pageId: WikiPageIdSchema },
    success: WikiPageSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.put("update", "/admin/wiki/pages/:pageId", {
    params: { pageId: WikiPageIdSchema },
    payload: WikiUpdateRequestSchema,
    success: WikiPageSchema,
    error: wikiWriteErrors
  }),
  HttpApiEndpoint.post("archive", "/admin/wiki/pages/:pageId/archive", {
    params: { pageId: WikiPageIdSchema },
    payload: WikiVersionRequestSchema,
    success: WikiArchiveResponseSchema,
    error: wikiWriteErrors
  }),
  HttpApiEndpoint.post("restoreArchived", "/admin/wiki/pages/:pageId/restore", {
    params: { pageId: WikiPageIdSchema },
    payload: WikiVersionRequestSchema,
    success: WikiPageSchema,
    error: wikiWriteErrors
  }),
  HttpApiEndpoint.get("history", "/admin/wiki/pages/:pageId/history", {
    params: { pageId: WikiPageIdSchema },
    query: WikiHistoryQuerySchema,
    success: WikiPageHistoryResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("restoreHistory", "/admin/wiki/pages/:pageId/history/:commitId/restore", {
    params: { pageId: WikiPageIdSchema, commitId: WikiRevisionIdSchema },
    payload: WikiVersionRequestSchema,
    success: WikiPageSchema,
    error: wikiWriteErrors
  }),
  HttpApiEndpoint.get("diff", "/admin/wiki/pages/:pageId/diff", {
    params: { pageId: WikiPageIdSchema },
    query: WikiDiffQuerySchema,
    success: WikiPageDiffResponseSchema,
    error: [HttpApiError.BadRequestNoContent, WikiConflictSchema, ...storeErrors]
  }),
  HttpApiEndpoint.get("versionDiff", "/admin/wiki/pages/:pageId/versions/diff", {
    params: { pageId: WikiPageIdSchema },
    query: WikiVersionDiffRouteOptionsSchema,
    success: WikiResourceDiffPageSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("links", "/admin/wiki/pages/:pageId/links", {
    params: { pageId: WikiPageIdSchema },
    success: WikiPageLinksSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("listRenameApprovals", "/admin/wiki/rename-approvals", {
    success: WikiRenameApprovalListResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("requestRename", "/admin/wiki/rename-approvals", {
    payload: WikiRenameRequestSchema,
    success: WikiRenameApprovalSchema,
    error: wikiWriteErrors
  }),
  HttpApiEndpoint.post("acceptRename", "/admin/wiki/rename-approvals/:approvalId/accept", {
    params: { approvalId: WikiRenameApprovalIdSchema },
    success: WikiRenameApprovalSchema,
    error: wikiWriteErrors
  }),
  HttpApiEndpoint.post("rejectRename", "/admin/wiki/rename-approvals/:approvalId/reject", {
    params: { approvalId: WikiRenameApprovalIdSchema },
    payload: Schema.UndefinedOr(WikiRenameRejectRequestSchema),
    success: WikiRenameApprovalSchema,
    error: wikiWriteErrors
  })
) {}
