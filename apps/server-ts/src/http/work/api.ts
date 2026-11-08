import {
  RecordedHistoryPageSchema,
  RecordedHistoryHttpQuerySchema
} from "../../persistence/history.js"
import {
  AcknowledgeTaskResultInputSchema,
  CreateChatTaskInputSchema,
  CreateSpaceTaskAttachmentInputSchema,
  CreateSpaceTaskCommentInputSchema,
  NewTaskInputSchema,
  CreateLooseTaskInputSchema,
  SpaceTaskAttachmentSchema,
  SpaceTaskCommentSchema,
  SpaceTaskSchema,
  SpaceWorkPageQuerySchema,
  SpaceWorkPageSchema,
  InternalUpdateSpaceTaskRequestSchema,
  MoveTaskToChatInputSchema,
  StopSpaceTaskInputSchema,
  StopSpaceTaskResponseSchema,
  WorkOkResponseSchema
} from "@arden-hq/protocol/effect/spaces/work"
import {
  HomeEvidencePageSchema,
  HomeEvidenceQuerySchema,
  HomeLetterResponseSchema,
  HomePresenceInputSchema,
  HomePresenceResponseSchema,
  ResolveRunQuestionInputSchema,
  RunQuestionListOptionsSchema,
  RunQuestionListSchema,
  RunQuestionSchema,
  WorkerAttemptPageQuerySchema,
  WorkerAttemptPageSchema
} from "@arden-hq/protocol/effect/runs"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { StoreConflict, storeErrors, StoreInvalid } from "../errors.js"

export class WorkApi extends HttpApiGroup.make("work", { topLevel: true }).add(
  HttpApiEndpoint.get("history", "/spaces/work/:itemId/history", {
    params: { itemId: Schema.NonEmptyString },
    query: RecordedHistoryHttpQuerySchema,
    success: RecordedHistoryPageSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("homeLetter", "/home/letter", {
    success: HomeLetterResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("homePresence", "/home/presence", {
    payload: HomePresenceInputSchema,
    success: HomePresenceResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("homeEvidence", "/home/evidence", {
    query: HomeEvidenceQuerySchema,
    success: HomeEvidencePageSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("moveToChat", "/spaces/work/:itemId/chat", {
    params: { itemId: Schema.NonEmptyString },
    payload: MoveTaskToChatInputSchema,
    success: WorkOkResponseSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("acknowledgeResult", "/spaces/work/:itemId/result-read", {
    params: { itemId: Schema.NonEmptyString },
    payload: AcknowledgeTaskResultInputSchema,
    success: WorkOkResponseSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("attempts", "/spaces/work/:itemId/attempts", {
    params: { itemId: Schema.NonEmptyString },
    query: WorkerAttemptPageQuerySchema,
    success: WorkerAttemptPageSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("questions", "/chat/questions", {
    query: RunQuestionListOptionsSchema,
    success: RunQuestionListSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("resolveQuestion", "/chat/questions/:questionId/answer", {
    params: { questionId: Schema.NonEmptyString },
    payload: ResolveRunQuestionInputSchema,
    success: RunQuestionSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("create", "/spaces/:spaceId/work", {
    params: { spaceId: Schema.NonEmptyString },
    payload: NewTaskInputSchema,
    success: SpaceTaskSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("createLoose", "/spaces/work", {
    payload: CreateLooseTaskInputSchema,
    success: SpaceTaskSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("createChatTask", "/sessions/:sessionId/chat-task", {
    params: { sessionId: Schema.NonEmptyString },
    payload: CreateChatTaskInputSchema,
    success: SpaceTaskSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("comment", "/spaces/work/:itemId/comments", {
    params: { itemId: Schema.NonEmptyString },
    payload: CreateSpaceTaskCommentInputSchema,
    success: SpaceTaskCommentSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.patch("update", "/spaces/work/:itemId", {
    params: { itemId: Schema.NonEmptyString },
    payload: InternalUpdateSpaceTaskRequestSchema,
    success: SpaceTaskSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("stop", "/spaces/work/:itemId/stop", {
    params: { itemId: Schema.NonEmptyString },
    payload: StopSpaceTaskInputSchema,
    success: StopSpaceTaskResponseSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("createAttachment", "/spaces/work/:itemId/attachments", {
    params: { itemId: Schema.NonEmptyString },
    payload: CreateSpaceTaskAttachmentInputSchema,
    success: SpaceTaskAttachmentSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("attachment", "/spaces/work/attachments/:attachmentId", {
    params: {
      attachmentId: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
    },
    success: HttpApiSchema.WithHeaders(Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()), {
      "content-type": Schema.NonEmptyString,
      "content-disposition": Schema.NonEmptyString
    }),
    error: [HttpApiError.NotFoundNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("page", "/spaces/work/all", {
    query: SpaceWorkPageQuerySchema,
    success: SpaceWorkPageSchema,
    error: storeErrors
  })
) {}
