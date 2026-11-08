import {
  RecordedHistoryHttpQuerySchema,
  RecordedHistoryPageSchema
} from "../../persistence/history.js"
import {
  CreateSpaceInputSchema,
  SpaceArchiveResponseSchema,
  SpaceConversationResponseSchema,
  SpaceDetailSchema,
  SpaceEndConflictSchema,
  SpaceListResponseSchema,
  SpaceSchema,
  SpacesOverviewSchema,
  PinnedSpacesInputSchema,
  UpdateSpaceInputSchema
} from "@arden-hq/protocol/effect/spaces"
import { Schema } from "effect"
import {
  SpaceOverviewHistoryPageSchema,
  SpaceOverviewHistoryQuerySchema
} from "../../persistence/summaries/store.js"
import { SessionEndQuerySchema } from "@arden-hq/protocol/effect/sessions"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { completionErrors, StoreConflict, storeErrors, StoreInvalid } from "../errors.js"

export class SpacesApi extends HttpApiGroup.make("spaces", { topLevel: true }).add(
  HttpApiEndpoint.get("configurationHistory", "/spaces/:spaceId/history", {
    params: { spaceId: Schema.NonEmptyString },
    query: RecordedHistoryHttpQuerySchema,
    success: RecordedHistoryPageSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("overviewHistory", "/spaces/:spaceId/overview-history", {
    params: { spaceId: Schema.NonEmptyString },
    query: SpaceOverviewHistoryQuerySchema,
    success: SpaceOverviewHistoryPageSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("list", "/spaces", {
    success: SpaceListResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("create", "/spaces", {
    payload: CreateSpaceInputSchema,
    success: SpaceSchema,
    error: [StoreInvalid, StoreConflict, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.patch("update", "/spaces/:spaceId", {
    params: { spaceId: Schema.NonEmptyString },
    payload: UpdateSpaceInputSchema,
    success: SpaceSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("createPage", "/spaces/:spaceId/page", {
    params: { spaceId: Schema.NonEmptyString },
    success: SpaceSchema,
    error: [HttpApiError.ConflictNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.delete("detachPage", "/spaces/:spaceId/page", {
    params: { spaceId: Schema.NonEmptyString },
    success: SpaceSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("restore", "/spaces/:spaceId/restore", {
    params: { spaceId: Schema.NonEmptyString },
    success: SpaceSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("generateInstructions", "/spaces/:spaceId/instructions/generate", {
    params: { spaceId: Schema.NonEmptyString },
    success: SpaceSchema,
    error: [...completionErrors, ...storeErrors]
  }),
  HttpApiEndpoint.get("overview", "/spaces/overview", {
    success: SpacesOverviewSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.put("pinned", "/spaces/pinned", {
    payload: PinnedSpacesInputSchema,
    success: SpacesOverviewSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("archived", "/spaces/archived", {
    success: SpaceListResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("conversation", "/spaces/:spaceId/conversation", {
    params: { spaceId: Schema.NonEmptyString },
    success: SpaceConversationResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("detail", "/spaces/:spaceId", {
    params: { spaceId: Schema.NonEmptyString },
    success: SpaceDetailSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.delete("archive", "/spaces/:spaceId", {
    params: { spaceId: Schema.NonEmptyString },
    query: SessionEndQuerySchema,
    success: SpaceArchiveResponseSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      SpaceEndConflictSchema.pipe(HttpApiSchema.status("Conflict")),
      HttpApiError.ServiceUnavailableNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  })
) {}
