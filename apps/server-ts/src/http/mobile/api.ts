import {
  MobileConversationSchema,
  MobileSpacesSchema,
  MobileHomeSchema,
  MobileTurnSchema
} from "@arden-hq/protocol/effect/mobile"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

export class MobileApi extends HttpApiGroup.make("mobile", { topLevel: true }).add(
  HttpApiEndpoint.get("home", "/mobile/home", {
    success: MobileHomeSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("spaces", "/mobile/spaces", {
    success: MobileSpacesSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("conversation", "/mobile/sessions/:sessionId/conversation", {
    params: { sessionId: Schema.NonEmptyString },
    query: Schema.Struct({ before: Schema.optionalKey(Schema.NonEmptyString) }),
    success: MobileConversationSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("turn", "/mobile/sessions/:sessionId/turns/:turnId", {
    params: { sessionId: Schema.NonEmptyString, turnId: Schema.NonEmptyString },
    success: MobileTurnSchema,
    error: [HttpApiError.NotFoundNoContent, HttpApiError.InternalServerErrorNoContent]
  })
) {}
