import {
  BrowserScopeInputSchema,
  BrowserScopeSnapshotSchema
} from "@arden-hq/protocol/effect/browser-scope"
import {
  RecordedHistoryHttpQuerySchema,
  RecordedHistoryPageSchema
} from "../../persistence/history.js"
import { MarkSessionReadResponseSchema } from "@arden-hq/protocol/effect/chat"
import {
  ArchivedSessionsResponseSchema,
  BranchSessionRequestSchema,
  BranchSessionResponseSchema,
  ChatFindQuerySchema,
  ChatFindResponseSchema,
  ChatSearchQuerySchema,
  ChatSearchResponseSchema,
  ClearSessionRequestSchema,
  ClearSessionResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  MoveSessionToSpaceRequestSchema,
  MoveSessionToSpaceResponseSchema,
  RenameSessionRequestSchema,
  RenameSessionResponseSchema,
  RevertSessionRequestSchema,
  RevertSessionResponseSchema,
  SessionEndConflictSchema,
  SessionEndQuerySchema,
  SessionExportQuerySchema,
  SessionExportResponseSchema,
  SessionLifecycleResponseSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionTriageActionRequestSchema,
  SessionTriageDecisionSchema,
  UpdateSessionModelRequestSchema,
  UpdateSessionModelResponseSchema
} from "@arden-hq/protocol/effect/sessions"
import {
  VisualizationListResponseSchema,
  VisualizationManifestResponseSchema,
  VisualizationRefSchema
} from "@arden-hq/protocol/effect/visualizations"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { completionErrors, StoreConflict, storeErrors, StoreInvalid } from "../errors.js"

const SessionEndConflictBodySchema = SessionEndConflictSchema.pipe(HttpApiSchema.status("Conflict"))
const sessionEndErrors = [
  HttpApiError.BadRequestNoContent,
  StoreInvalid,
  HttpApiError.NotFoundNoContent,
  SessionEndConflictBodySchema,
  HttpApiError.ServiceUnavailableNoContent,
  HttpApiError.InternalServerErrorNoContent
]

export class SessionsApi extends HttpApiGroup.make("sessions", { topLevel: true }).add(
  HttpApiEndpoint.post("browserScope", "/browser/scope", {
    payload: BrowserScopeInputSchema,
    success: BrowserScopeSnapshotSchema,
    error: [HttpApiError.NotFoundNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("configurationHistory", "/sessions/:sessionId/configuration-history", {
    params: { sessionId: Schema.NonEmptyString },
    query: RecordedHistoryHttpQuerySchema,
    success: RecordedHistoryPageSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("clear", "/session/clear", {
    payload: Schema.UndefinedOr(ClearSessionRequestSchema),
    success: ClearSessionResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      StoreConflict,
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("revert", "/session/revert", {
    payload: Schema.UndefinedOr(RevertSessionRequestSchema),
    success: RevertSessionResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      StoreConflict,
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("list", "/sessions", {
    query: SessionListQuerySchema,
    success: SessionListResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("create", "/sessions", {
    payload: CreateSessionRequestSchema,
    success: CreateSessionResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("branch", "/sessions/:sessionId/branch", {
    params: { sessionId: Schema.NonEmptyString },
    payload: BranchSessionRequestSchema,
    success: BranchSessionResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.patch("rename", "/sessions/:sessionId", {
    params: { sessionId: Schema.NonEmptyString },
    payload: RenameSessionRequestSchema,
    success: RenameSessionResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.put("model", "/sessions/:sessionId/model", {
    params: { sessionId: Schema.NonEmptyString },
    payload: UpdateSessionModelRequestSchema,
    success: UpdateSessionModelResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("move", "/sessions/:sessionId/space", {
    params: { sessionId: Schema.NonEmptyString },
    payload: MoveSessionToSpaceRequestSchema,
    success: MoveSessionToSpaceResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("exportSession", "/sessions/:sessionId/export", {
    params: { sessionId: Schema.NonEmptyString },
    query: SessionExportQuerySchema,
    success: SessionExportResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("find", "/sessions/:sessionId/find", {
    params: { sessionId: Schema.NonEmptyString },
    query: ChatFindQuerySchema,
    success: ChatFindResponseSchema,
    error: [HttpApiError.BadRequestNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("search", "/sessions/search", {
    query: ChatSearchQuerySchema,
    success: ChatSearchResponseSchema,
    error: [HttpApiError.BadRequestNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("triage", "/sessions/:sessionId/triage", {
    params: { sessionId: Schema.NonEmptyString },
    success: SessionTriageDecisionSchema,
    error: [
      HttpApiError.NotFoundNoContent,
      ...completionErrors,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.put("settleTriage", "/sessions/:sessionId/triage", {
    params: { sessionId: Schema.NonEmptyString },
    payload: SessionTriageActionRequestSchema,
    success: SessionTriageDecisionSchema,
    error: [
      StoreConflict,
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      HttpApiError.ServiceUnavailableNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("visualizations", "/sessions/:sessionId/visualizations", {
    params: { sessionId: Schema.NonEmptyString },
    success: VisualizationListResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("visualization", "/sessions/:sessionId/visualizations/:artifactRef", {
    params: { sessionId: Schema.NonEmptyString, artifactRef: VisualizationRefSchema },
    success: VisualizationManifestResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get(
    "visualizationContent",
    "/sessions/:sessionId/visualizations/:artifactRef/content",
    {
      params: { sessionId: Schema.NonEmptyString, artifactRef: VisualizationRefSchema },
      success: HttpApiSchema.WithHeaders(Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()), {
        "content-type": Schema.NonEmptyString
      }),
      error: [HttpApiError.BadRequestNoContent, ...storeErrors]
    }
  ),
  HttpApiEndpoint.get("archived", "/sessions/archived", {
    success: ArchivedSessionsResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.delete("archive", "/sessions/:sessionId", {
    params: { sessionId: Schema.NonEmptyString },
    query: SessionEndQuerySchema,
    success: SessionLifecycleResponseSchema,
    error: sessionEndErrors
  }),
  HttpApiEndpoint.post("restore", "/sessions/:sessionId/restore", {
    params: { sessionId: Schema.NonEmptyString },
    success: SessionLifecycleResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("continueRun", "/sessions/:sessionId/continue", {
    params: { sessionId: Schema.NonEmptyString },
    success: SessionLifecycleResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.delete("permanentDelete", "/sessions/:sessionId/permanent", {
    params: { sessionId: Schema.NonEmptyString },
    query: SessionEndQuerySchema,
    success: SessionLifecycleResponseSchema,
    error: sessionEndErrors
  }),
  HttpApiEndpoint.post("read", "/sessions/:sessionId/read", {
    params: { sessionId: Schema.NonEmptyString },
    success: MarkSessionReadResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  })
) {}
