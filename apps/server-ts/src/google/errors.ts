import { Effect, Schema } from "effect"

export const GoogleConnectionDiagnostic = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({ kind: Schema.Literal("transport"), retryable: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("http"),
    status: Schema.Number,
    reason: Schema.Literals(["auth", "rate_limit", "provider", "request"] as const),
    retryAfterMs: Schema.UndefinedOr(Schema.Number),
    retryable: Schema.Boolean
  })
])
export type GoogleConnectionDiagnostic = typeof GoogleConnectionDiagnostic.Type

export class GoogleConnectionError extends Schema.TaggedError<GoogleConnectionError>()(
  "GoogleConnectionError",
  {
    reason: Schema.Literals([
      "access_denied",
      "not_configured",
      "auth_required",
      "not_found",
      "invalid_response",
      "provider",
      "storage"
    ] as const),
    message: Schema.String,
    diagnostic: GoogleConnectionDiagnostic.pipe(
      Schema.withConstructorDefault(Effect.succeed({ kind: "local" as const }))
    ),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}
