import type { PauseRequested } from "@arden-hq/loop"
import { GoogleServiceIdSchema } from "@arden-hq/protocol/effect/google"
import type { GoogleServiceId } from "@arden-hq/protocol/google"
import {
  CONNECTION_ACCOUNT,
  CONNECTION_ACTION,
  CONNECTION_STATE,
  type ConnectionState
} from "@arden-hq/protocol/chat"
import { Effect, Schema } from "effect"

import {
  CONNECTION_CHECK_FAILURE,
  CONNECTION_PROVIDER,
  ConnectionCheckError,
  type ConnectionCheckFailure,
  requestConnection,
  type ConnectionCheck
} from "../connections/recovery.js"
import type { GoogleConnectionError, GoogleConnectionReason } from "./errors.js"
import { GOOGLE_SCOPES } from "./oauth-endpoints.js"
import { GoogleConnections } from "./service.js"

export const GOOGLE_SERVICE_NAMES: Readonly<
  Record<
    GoogleServiceId,
    { readonly label: string; readonly account: string; readonly failure: string }
  >
> = {
  gmail: { label: "Gmail", account: "Gmail", failure: "Gmail" },
  calendar: { label: "Google Calendar", account: "Calendar", failure: "Calendar" },
  google_drive: { label: "Google Drive", account: "Drive", failure: "Google Drive" }
}

const PAUSE_STATE: Record<GoogleConnectionReason, ConnectionState | undefined> = {
  access_denied: undefined,
  not_configured: CONNECTION_STATE.notConfigured,
  auth_required: CONNECTION_STATE.authRequired,
  not_found: undefined,
  invalid_response: undefined,
  provider: undefined,
  storage: undefined
}

export const googleConnectionPause = (
  error: GoogleConnectionError,
  service: GoogleServiceId,
  accountRef?: string
): PauseRequested | undefined => {
  const state = PAUSE_STATE[error.reason]
  if (state === undefined) return undefined
  const label = GOOGLE_SERVICE_NAMES[service].label
  return requestConnection({
    provider: CONNECTION_PROVIDER.google,
    service,
    label,
    reason: state,
    detail: error.message,
    capability: `Use ${label}`,
    action:
      state === CONNECTION_STATE.notConfigured
        ? CONNECTION_ACTION.settings
        : CONNECTION_ACTION.oauth,
    settingsTab: "integrations",
    requiredScopes: GOOGLE_SCOPES[service],
    ...(accountRef === undefined ? {} : { accountRef })
  })
}

const CHECK_FAILURE: Record<GoogleConnectionReason, ConnectionCheckFailure> = {
  access_denied: CONNECTION_CHECK_FAILURE.rejected,
  auth_required: CONNECTION_CHECK_FAILURE.rejected,
  not_found: CONNECTION_CHECK_FAILURE.rejected,
  invalid_response: CONNECTION_CHECK_FAILURE.rejected,
  not_configured: CONNECTION_CHECK_FAILURE.unavailable,
  provider: CONNECTION_CHECK_FAILURE.unavailable,
  storage: CONNECTION_CHECK_FAILURE.storage
}

const checkError = (error: GoogleConnectionError): ConnectionCheckError =>
  new ConnectionCheckError({ reason: CHECK_FAILURE[error.reason], cause: error })

export const googleConnectionCheck: Effect.Effect<ConnectionCheck, never, GoogleConnections> =
  Effect.gen(function* () {
    const google = yield* GoogleConnections
    return (decision) =>
      Schema.decodeUnknownEffect(GoogleServiceIdSchema)(decision.service).pipe(
        Effect.mapError((cause) => new ConnectionCheckError({ reason: "rejected", cause })),
        Effect.flatMap((service) =>
          google
            .verify(
              service,
              decision.snapshot.account.kind === CONNECTION_ACCOUNT.account
                ? decision.snapshot.account.ref
                : undefined
            )
            .pipe(Effect.mapError(checkError))
        )
      )
  })
