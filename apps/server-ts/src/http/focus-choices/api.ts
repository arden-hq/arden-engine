import {
  FocusChoiceSchema,
  ResolveFocusChoiceInputSchema,
  ResolveFocusChoiceResponseSchema
} from "@arden-hq/protocol/effect/sessions/focus-choices"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreConflict, storeErrors, StoreInvalid } from "../errors.js"

export class FocusChoicesApi extends HttpApiGroup.make("focusChoices", { topLevel: true }).add(
  HttpApiEndpoint.get("get", "/spaces/:spaceId/focus-choices/:questionId", {
    params: {
      spaceId: Schema.NonEmptyString,
      questionId: Schema.NonEmptyString
    },
    success: FocusChoiceSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("resolve", "/spaces/:spaceId/focus-choices/:questionId/resolve", {
    params: {
      spaceId: Schema.NonEmptyString,
      questionId: Schema.NonEmptyString
    },
    payload: ResolveFocusChoiceInputSchema,
    success: ResolveFocusChoiceResponseSchema,
    error: [
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      StoreInvalid,
      HttpApiError.InternalServerErrorNoContent
    ]
  })
) {}
