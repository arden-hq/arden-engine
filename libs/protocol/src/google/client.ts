import { Schema } from "effect"
export const GoogleOAuthCancelledSchema = Schema.Struct({ status: Schema.Literal("cancelled") })
import {
  GOOGLE_CLIENT_BLOCK,
  GOOGLE_CLIENT_CONFIGURED,
  GOOGLE_CLIENT_REPLACEMENT,
  GOOGLE_CLIENT_SECRET,
  type GoogleClientConfigured,
  type GoogleClientReplacement,
  type GoogleDesktopClientFile,
  type GoogleOAuthClient
} from "./contracts.js"

const GoogleClientBlockSchema = Schema.Literals(Object.values(GOOGLE_CLIENT_BLOCK))

export const GoogleClientReplacementSchema: Schema.Codec<GoogleClientReplacement> = Schema.Union([
  Schema.Struct({ status: Schema.Literal(GOOGLE_CLIENT_REPLACEMENT.ready) }),
  Schema.Struct({
    status: Schema.Literal(GOOGLE_CLIENT_REPLACEMENT.blocked),
    reason: GoogleClientBlockSchema
  })
])

export const GoogleOAuthClientSchema: Schema.Codec<GoogleOAuthClient> = Schema.Struct({
  clientId: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  secret: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(GOOGLE_CLIENT_SECRET.public) }),
    Schema.Struct({
      kind: Schema.Literal(GOOGLE_CLIENT_SECRET.confidential),
      clientSecret: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512))
    })
  ])
})

export const GoogleClientConfiguredSchema: Schema.Codec<GoogleClientConfigured> = Schema.Union([
  Schema.Struct({ status: Schema.Literal(GOOGLE_CLIENT_CONFIGURED.configured) }),
  Schema.Struct({
    status: Schema.Literal(GOOGLE_CLIENT_CONFIGURED.blocked),
    reason: GoogleClientBlockSchema
  })
])

export const GoogleDesktopClientFileSchema: Schema.Codec<GoogleDesktopClientFile> = Schema.Struct({
  installed: Schema.Struct({
    client_id: Schema.Trimmed.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(512),
      Schema.isPattern(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/)
    ),
    client_secret: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    project_id: Schema.String,
    auth_uri: Schema.Literals([
      "https://accounts.google.com/o/oauth2/auth",
      "https://accounts.google.com/o/oauth2/v2/auth"
    ]),
    token_uri: Schema.Literal("https://oauth2.googleapis.com/token"),
    auth_provider_x509_cert_url: Schema.Literal("https://www.googleapis.com/oauth2/v1/certs"),
    redirect_uris: Schema.Array(Schema.Literals(["http://localhost", "http://127.0.0.1"]))
  })
})
