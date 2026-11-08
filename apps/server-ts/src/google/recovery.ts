import type { PauseRequested } from "@arden-hq/loop"
import { GoogleServiceIdSchema } from "@arden-hq/protocol/effect/google"
import type { GoogleServiceId } from "@arden-hq/protocol/google"
import { Effect, Schema } from "effect"

import {
  ConnectionCheckError,
  requestConnection,
  type ConnectionCheck
} from "../connections/recovery.js"
import type { GoogleConnectionError } from "./errors.js"
import { GOOGLE_SCOPES } from "./oauth.js"
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

export const googleConnectionPause = (
  error: GoogleConnectionError,
  service: GoogleServiceId,
  accountRef?: string
): PauseRequested | undefined => {
  if (error.reason !== "auth_required" && error.reason !== "not_configured") return undefined
  const label = GOOGLE_SERVICE_NAMES[service].label
  return requestConnection({
    provider: "google",
    service,
    label,
    reason: error.reason,
    detail: error.message,
    capability: `Use ${label}`,
    action: error.reason === "not_configured" ? "settings" : "oauth",
    settingsTab: "integrations",
    requiredScopes: GOOGLE_SCOPES[service],
    ...(accountRef === undefined ? {} : { accountRef })
  })
}

const checkError = (error: GoogleConnectionError): ConnectionCheckError => {
  switch (error.reason) {
    case "access_denied":
    case "auth_required":
    case "not_found":
    case "invalid_response":
      return new ConnectionCheckError({ reason: "rejected", cause: error })
    case "not_configured":
    case "provider":
      return new ConnectionCheckError({ reason: "unavailable", cause: error })
    case "storage":
      return new ConnectionCheckError({ reason: "storage", cause: error })
  }
}

export const googleConnectionCheck: Effect.Effect<ConnectionCheck, never, GoogleConnections> =
  Effect.gen(function* () {
    const google = yield* GoogleConnections
    return (decision) =>
      Schema.decodeUnknownEffect(GoogleServiceIdSchema)(decision.service).pipe(
        Effect.mapError((cause) => new ConnectionCheckError({ reason: "rejected", cause })),
        Effect.flatMap((service) =>
          google
            .verify(service, decision.snapshot.account_ref ?? undefined)
            .pipe(Effect.mapError(checkError))
        )
      )
  })
