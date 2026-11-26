import { Effect, Schema } from "effect"
import { VaultError } from "../credentials/vault.js"

export const GOOGLE_DIAGNOSTIC = { local: "local", transport: "transport", http: "http" } as const

export const GOOGLE_API_ERROR_REASON = {
  auth: "auth",
  rateLimit: "rate_limit",
  provider: "provider",
  request: "request"
} as const

export const GOOGLE_CONNECTION_REASON = {
  accessDenied: "access_denied",
  notConfigured: "not_configured",
  authRequired: "auth_required",
  notFound: "not_found",
  invalidResponse: "invalid_response",
  provider: "provider",
  storage: "storage"
} as const

export type GoogleConnectionReason =
  (typeof GOOGLE_CONNECTION_REASON)[keyof typeof GOOGLE_CONNECTION_REASON]

export const GoogleConnectionDiagnostic = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(GOOGLE_DIAGNOSTIC.local) }),
  Schema.Struct({ kind: Schema.Literal(GOOGLE_DIAGNOSTIC.transport), retryable: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal(GOOGLE_DIAGNOSTIC.http),
    status: Schema.Number,
    reason: Schema.Literals(Object.values(GOOGLE_API_ERROR_REASON)),
    retryAfterMs: Schema.UndefinedOr(Schema.Number),
    retryable: Schema.Boolean
  })
])
export type GoogleConnectionDiagnostic = typeof GoogleConnectionDiagnostic.Type

export class GoogleConnectionError extends Schema.TaggedError<GoogleConnectionError>()(
  "GoogleConnectionError",
  {
    reason: Schema.Literals(Object.values(GOOGLE_CONNECTION_REASON)),
    message: Schema.String,
    diagnostic: GoogleConnectionDiagnostic.pipe(
      Schema.withConstructorDefault(Effect.succeed({ kind: GOOGLE_DIAGNOSTIC.local }))
    ),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const googleAuthorizationError = (cause: unknown): GoogleConnectionError => {
  if (cause instanceof GoogleConnectionError) return cause
  if (cause instanceof VaultError) {
    return new GoogleConnectionError({
      reason: "storage",
      message: "Google credentials are unavailable",
      cause
    })
  }
  return new GoogleConnectionError({
    reason: "provider",
    message: "Google authorization failed",
    cause
  })
}
