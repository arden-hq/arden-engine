import {
  DismissInboxRequestSchema,
  InboxViewSchema,
  MarkInboxReadRequestSchema
} from "@arden-hq/protocol/effect/inbox"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreInvalid } from "../errors.js"

export class InboxApi extends HttpApiGroup.make("inbox", { topLevel: true }).add(
  HttpApiEndpoint.get("view", "/inbox", {
    success: InboxViewSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("markRead", "/inbox/read", {
    payload: MarkInboxReadRequestSchema,
    success: InboxViewSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.post("dismiss", "/inbox/dismiss", {
    payload: DismissInboxRequestSchema,
    success: InboxViewSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  })
) {}
