import {
  AcknowledgeSpaceContinuityRequestSchema,
  SpaceContinuitySeenStateSchema,
  SpaceContinuityStateResponseSchema
} from "@arden-hq/protocol/effect/spaces/continuity"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreConflict, storeErrors, StoreInvalid } from "../errors.js"

export class ContinuityApi extends HttpApiGroup.make("continuity", { topLevel: true }).add(
  HttpApiEndpoint.get("state", "/spaces/:spaceId/continuity/state", {
    params: { spaceId: Schema.NonEmptyString },
    success: SpaceContinuityStateResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("acknowledge", "/spaces/:spaceId/continuity/acknowledge", {
    params: { spaceId: Schema.NonEmptyString },
    payload: AcknowledgeSpaceContinuityRequestSchema,
    success: SpaceContinuitySeenStateSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  })
) {}
