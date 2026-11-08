import {
  GoogleOAuthCancelledSchema,
  GoogleClientReplacementSchema,
  GoogleAccountIdSchema,
  GoogleAccountListResponseSchema,
  GoogleClientConfiguredSchema,
  GoogleDisconnectReceiptSchema,
  GoogleGrantSchema,
  GoogleOAuthClientSchema,
  GoogleOAuthStartResponseSchema,
  GoogleServiceIdSchema
} from "@arden-hq/protocol/effect/google"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreInvalid } from "../errors.js"

const googleMutationErrors = [
  HttpApiError.NotFoundNoContent,
  StoreInvalid,
  HttpApiError.ServiceUnavailableNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const

export class GoogleApi extends HttpApiGroup.make("google", { topLevel: true }).add(
  HttpApiEndpoint.delete("cancelOAuth", "/google/oauth", {
    success: GoogleOAuthCancelledSchema,
    error: googleMutationErrors
  }),
  HttpApiEndpoint.post("prepareClientReplacement", "/google/client/replacement", {
    payload: Schema.Struct({ disconnectAccounts: Schema.Boolean }),
    success: GoogleClientReplacementSchema,
    error: googleMutationErrors
  }),
  HttpApiEndpoint.post("configureClient", "/google/client", {
    payload: GoogleOAuthClientSchema,
    success: GoogleClientConfiguredSchema,
    error: googleMutationErrors
  }),
  HttpApiEndpoint.get("listAccounts", "/google/accounts", {
    success: GoogleAccountListResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("startOAuth", "/google/:service/oauth", {
    params: { service: GoogleServiceIdSchema },
    success: GoogleOAuthStartResponseSchema,
    error: googleMutationErrors
  }),
  HttpApiEndpoint.post("startGrantOAuth", "/google/accounts/:accountId/grants/:grant", {
    params: { accountId: GoogleAccountIdSchema, grant: GoogleGrantSchema },
    success: GoogleOAuthStartResponseSchema,
    error: googleMutationErrors
  }),
  HttpApiEndpoint.delete("disconnect", "/google/:service/accounts/:accountId", {
    params: { service: GoogleServiceIdSchema, accountId: GoogleAccountIdSchema },
    success: GoogleDisconnectReceiptSchema,
    error: googleMutationErrors
  })
) {}
