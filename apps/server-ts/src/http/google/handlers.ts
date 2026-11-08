import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import type { GoogleConnectionError } from "../../google/errors.js"
import { GoogleConnections } from "../../google/service.js"
import { ArdenApi } from "../api.js"
import { StoreInvalid, storeErrorToHttp } from "../errors.js"

const mapError = (
  error: GoogleConnectionError
):
  | HttpApiError.NotFound
  | StoreInvalid
  | HttpApiError.ServiceUnavailable
  | HttpApiError.InternalServerError => {
  if (
    error.reason === "access_denied" ||
    error.reason === "auth_required" ||
    error.reason === "invalid_response"
  )
    return new StoreInvalid({})
  if (error.reason === "not_configured" || error.reason === "provider")
    return new HttpApiError.ServiceUnavailable({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

export const GoogleHandlers = HttpApiBuilder.group(
  ArdenApi,
  "google",
  Effect.fn("GoogleHandlers")(function* (handlers) {
    const google = yield* GoogleConnections
    return handlers
      .handle("cancelOAuth", () => google.cancelOAuth().pipe(Effect.mapError(mapError)))
      .handle("prepareClientReplacement", ({ payload }) =>
        google.prepareClientReplacement(payload.disconnectAccounts).pipe(Effect.mapError(mapError))
      )
      .handle("configureClient", ({ payload }) =>
        google.configureClient(payload).pipe(Effect.mapError(mapError))
      )
      .handle("listAccounts", () =>
        google.list().pipe(
          Effect.map((response) => ({
            oauth_configured: response.oauthConfigured,
            pending_oauth: response.pendingOAuth,
            accounts: response.accounts.map((account) => ({
              id: account.id,
              email: account.email,
              authorizations: account.authorizations.map((authorization) => ({
                service: authorization.service,
                scopes: authorization.scopes,
                status: authorization.status
              }))
            }))
          })),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("startOAuth", ({ params }) =>
        google.startOAuth(params.service).pipe(
          Effect.map((response) => ({
            service: response.service,
            authorization_url: response.authorizationUrl,
            expires_at: response.expiresAt,
            status: response.status
          })),
          Effect.mapError(mapError)
        )
      )
      .handle("startGrantOAuth", ({ params }) =>
        google.startGrantOAuth(params.grant, params.accountId).pipe(
          Effect.map((response) => ({
            service: response.service,
            authorization_url: response.authorizationUrl,
            expires_at: response.expiresAt,
            status: response.status
          })),
          Effect.mapError(mapError)
        )
      )
      .handle("disconnect", ({ params }) =>
        google.disconnect(params.service, params.accountId).pipe(
          Effect.map((response) => ({
            status: response.status,
            service: response.service,
            account_id: response.accountId
          })),
          Effect.mapError(mapError)
        )
      )
  })
)
