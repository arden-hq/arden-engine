import { Schema } from "effect"
export const GoogleOAuthCancelledSchema = Schema.Struct({ status: Schema.Literal("cancelled") })
export const GoogleClientReplacementSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    reason: Schema.Literals(["accounts_connected", "authorization_pending"])
  })
])

import type {
  GoogleClientConfigured,
  GoogleDesktopClientFile,
  GoogleOAuthClient
} from "./contracts.js"

export const GoogleOAuthClientSchema: Schema.Codec<GoogleOAuthClient> = Schema.Struct({
  clientId: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  clientSecret: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512))
  )
})

export const GoogleClientConfiguredSchema: Schema.Codec<GoogleClientConfigured> = Schema.Union([
  Schema.Struct({ status: Schema.Literal("configured") }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    reason: Schema.Literals(["accounts_connected", "authorization_pending"])
  })
])

/** Only the downloaded Desktop-app shape is accepted; endpoint fields cannot redirect credentials. */
export const GoogleDesktopClientFileSchema: Schema.Codec<GoogleDesktopClientFile> = Schema.Struct({
  installed: Schema.Struct({
    client_id: Schema.Trimmed.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(512),
      Schema.isPattern(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/)
    ),
    client_secret: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    project_id: Schema.optionalKey(Schema.String),
    auth_uri: Schema.optionalKey(
      Schema.Literals([
        "https://accounts.google.com/o/oauth2/auth",
        "https://accounts.google.com/o/oauth2/v2/auth"
      ])
    ),
    token_uri: Schema.optionalKey(Schema.Literal("https://oauth2.googleapis.com/token")),
    auth_provider_x509_cert_url: Schema.optionalKey(
      Schema.Literal("https://www.googleapis.com/oauth2/v1/certs")
    ),
    redirect_uris: Schema.optionalKey(
      Schema.Array(Schema.Literals(["http://localhost", "http://127.0.0.1"]))
    )
  })
})
