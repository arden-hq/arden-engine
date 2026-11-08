import { Schema } from "effect"
import { decoderFor, makeEncoder, runBoundary, strict } from "../common/boundary.js"
import type {
  BranchSessionRequest,
  ClearSessionRequest,
  CreateSessionRequest,
  HandCaptureRequest,
  MoveSessionToSpaceRequest,
  SessionTriageAction,
  SessionTriageActionRequest,
  RenameSessionRequest,
  RevertSessionRequest,
  SessionExportFormat,
  SessionListOptions,
  UpdateSessionModelRequest
} from "./contracts.js"
import {
  ArchivedSessionsResponseSchema,
  BranchSessionResponseSchema,
  ChatFindResponseSchema,
  ChatSearchResponseSchema,
  ClearSessionResponseSchema,
  CreateSessionResponseSchema,
  HandCaptureResponseSchema,
  RenameSessionResponseSchema,
  RevertSessionResponseSchema,
  MoveSessionToSpaceResponseSchema,
  SessionExportResponseSchema,
  SessionLifecycleResponseSchema,
  SessionEndConflictSchema,
  SessionListResponseSchema,
  SessionTriageDecisionSchema,
  UpdateSessionModelResponseSchema,
  encodeBranchSessionRequestEffect,
  encodeClearSessionRequestEffect,
  encodeCreateSessionRequestEffect,
  encodeHandCaptureRequestEffect,
  encodeMoveSessionToSpaceRequestEffect,
  encodeRenameSessionRequestEffect,
  encodeRevertSessionRequestEffect,
  encodeSessionTriageActionRequestEffect,
  encodeUpdateSessionModelRequestEffect
} from "./schema.js"
import {
  encodeSessionBranchPathEffect,
  encodeSessionItemPathEffect,
  encodeSessionListPathEffect,
  encodeSessionModelPathEffect,
  encodeSessionMoveToSpacePathEffect,
  encodeSessionExportPathEffect,
  encodeSessionPermanentDeletePathEffect,
  encodeSessionArchivePathEffect,
  encodeSessionRestorePathEffect,
  encodeSessionContinuePathEffect,
  encodeSessionTriagePathEffect,
  encodeChatFindPathEffect,
  encodeChatSearchPathEffect
} from "./routes.js"

export * from "./contracts.js"

/** A refused archive or delete's 409 body (`SessionEndConflict`). */
export const isSessionEndConflict = Schema.is(SessionEndConflictSchema)

export const sessionDecoders = {
  listResponse: decoderFor(SessionListResponseSchema, "Invalid session-list response"),
  createResponse: decoderFor(CreateSessionResponseSchema, "Invalid create-session response"),
  branchResponse: decoderFor(BranchSessionResponseSchema, "Invalid branch-session response"),
  clearResponse: decoderFor(ClearSessionResponseSchema, "Invalid clear-session response"),
  renameResponse: decoderFor(RenameSessionResponseSchema, "Invalid rename-session response"),
  modelResponse: decoderFor(UpdateSessionModelResponseSchema, "Invalid session-model response"),
  archivedResponse: decoderFor(
    ArchivedSessionsResponseSchema,
    "Invalid archived-sessions response"
  ),
  lifecycleResponse: decoderFor(
    SessionLifecycleResponseSchema,
    "Invalid session lifecycle response"
  ),
  revertResponse: decoderFor(RevertSessionResponseSchema, "Invalid revert-session response"),
  moved: decoderFor(MoveSessionToSpaceResponseSchema, "Invalid move-session response"),
  exported: decoderFor(SessionExportResponseSchema, "Invalid session-export response"),
  triage: decoderFor(SessionTriageDecisionSchema, "Invalid session-triage response", strict),
  capture: decoderFor(HandCaptureResponseSchema, "Invalid capture response", strict),
  find: decoderFor(ChatFindResponseSchema, "Invalid chat-find response"),
  search: decoderFor(ChatSearchResponseSchema, "Invalid chat-search response")
} as const

const createRequest = makeEncoder<CreateSessionRequest>(
  encodeCreateSessionRequestEffect,
  "Invalid create-session request"
)
const branchRequest = makeEncoder<BranchSessionRequest>(
  encodeBranchSessionRequestEffect,
  "Invalid branch-session request"
)
const renameRequest = makeEncoder<RenameSessionRequest>(
  encodeRenameSessionRequestEffect,
  "Invalid rename-session request"
)
const modelRequest = makeEncoder<UpdateSessionModelRequest>(
  encodeUpdateSessionModelRequestEffect,
  "Invalid session-model request"
)
const clearRequest = makeEncoder<ClearSessionRequest>(
  encodeClearSessionRequestEffect,
  "Invalid clear-session request"
)
const revertRequest = makeEncoder<RevertSessionRequest>(
  encodeRevertSessionRequestEffect,
  "Invalid revert-session request"
)
const triageActionRequest = makeEncoder<SessionTriageActionRequest>(
  encodeSessionTriageActionRequestEffect,
  "Invalid session-triage action request"
)
const captureRequest = makeEncoder<HandCaptureRequest>(
  encodeHandCaptureRequestEffect,
  "Invalid capture request"
)
const moveRequest = makeEncoder<MoveSessionToSpaceRequest>(
  encodeMoveSessionToSpaceRequestEffect,
  "Invalid move-session request"
)
/** Plain, reusable JSON bodies for session mutations. */
export const sessionRequests = {
  create: createRequest,
  branch: branchRequest,
  rename: (name: string): string => renameRequest({ name }),
  setModel: (chatModel: string | null): string => modelRequest({ chat_model: chatModel }),
  clear: (sessionId: string | null = null): string => clearRequest({ session_id: sessionId }),
  revert: revertRequest,
  moveToSpace: (spaceId: string | null): string => moveRequest({ space_id: spaceId }),
  triageAction: (action: SessionTriageAction): string => triageActionRequest({ action }),
  capture: captureRequest
} as const

const route = (program: ReturnType<typeof encodeSessionItemPathEffect>, message: string): string =>
  runBoundary(program, message, "encode")

/** Validated paths for the current Session lifecycle. */
export const sessionRoutes = {
  collection: "/sessions",
  capture: "/captures",
  list(options: SessionListOptions = {}): string {
    return runBoundary(encodeSessionListPathEffect(options), "Invalid session-list route", "encode")
  },
  archived: "/sessions/archived",
  clear: "/session/clear",
  revert: "/session/revert",
  item(sessionId: string): string {
    return route(encodeSessionItemPathEffect(sessionId), "Invalid session route")
  },
  branch(sessionId: string): string {
    return route(encodeSessionBranchPathEffect(sessionId), "Invalid session-branch route")
  },
  model(sessionId: string): string {
    return route(encodeSessionModelPathEffect(sessionId), "Invalid session-model route")
  },
  moveToSpace(sessionId: string): string {
    return route(encodeSessionMoveToSpacePathEffect(sessionId), "Invalid move-session route")
  },
  export(sessionId: string, format: SessionExportFormat): string {
    return runBoundary(
      encodeSessionExportPathEffect({ sessionId, format }),
      "Invalid session-export route",
      "encode"
    )
  },
  restore(sessionId: string): string {
    return route(encodeSessionRestorePathEffect(sessionId), "Invalid session-restore route")
  },
  continueRun(sessionId: string): string {
    return route(encodeSessionContinuePathEffect(sessionId), "Invalid session-continue route")
  },
  triage(sessionId: string): string {
    return route(encodeSessionTriagePathEffect(sessionId), "Invalid session-triage route")
  },
  /** Every message of one chat that holds `query`, loaded or not. */
  find(sessionId: string, query: string): string {
    return runBoundary(
      encodeChatFindPathEffect({ sessionId, query }),
      "Invalid chat-find route",
      "encode"
    )
  },
  /** The best matches for `query` across all conversations. */
  search(query: string): string {
    return runBoundary(encodeChatSearchPathEffect(query), "Invalid chat-search route", "encode")
  },
  archive(sessionId: string, { stop }: { readonly stop: boolean }): string {
    return runBoundary(
      encodeSessionArchivePathEffect({ sessionId, stop }),
      "Invalid session-archive route",
      "encode"
    )
  },
  permanentDelete(sessionId: string, { stop }: { readonly stop: boolean }): string {
    return runBoundary(
      encodeSessionPermanentDeletePathEffect({ sessionId, stop }),
      "Invalid permanent-delete route",
      "encode"
    )
  }
} as const
