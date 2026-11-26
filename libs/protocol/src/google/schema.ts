import { PLAIN_HTTP, SERVER_URL_ISSUE, serverUrlIssue } from "@arden-hq/std/url"
import { strict } from "../common/boundary.js"
import { Effect, Schema } from "effect"
import { encodeSegment } from "../common/routes.js"
import type { Agrees, Assert } from "../common/type-agreement.js"
import {
  GOOGLE_AUTHORIZATION_STATUS,
  GOOGLE_GRANT,
  GOOGLE_SERVICE_ID,
  type GoogleAccount,
  type GoogleAuthorizationStatus,
  type GoogleAccountListResponse,
  type GoogleDisconnectReceipt,
  type GoogleOAuthStartResponse,
  type GoogleServiceAuthorization
} from "./contracts.js"

const googlePath = "/google"

export const GoogleServiceIdSchema = Schema.Literals(Object.values(GOOGLE_SERVICE_ID))

export const GoogleAccountIdSchema = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/)
)

export const GoogleAccountGrantsSchema = Schema.Array(
  Schema.Struct({
    account_id: Schema.NonEmptyString.check(Schema.isMaxLength(255)).annotate({
      description:
        "Stable Google account ID from connected accounts; never an email or display name."
    }),
    service: GoogleServiceIdSchema.annotate({
      description: "Google service this account grant authorizes."
    })
  })
).check(
  Schema.isMaxLength(128),
  Schema.makeFilter((accounts) =>
    new Set(accounts.map((account) => JSON.stringify([account.account_id, account.service])))
      .size === accounts.length
      ? undefined
      : "contains duplicate account grants"
  )
)

const GoogleEmailSchema = Schema.Trimmed.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^@\s]+@[^@\s]+$/u)
)

const GoogleScopeSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[\x21-\x7E]+$/u)
)

const GoogleAuthorizationStatusSchema = Schema.Literals(Object.values(GOOGLE_AUTHORIZATION_STATUS))

const GoogleAuthorizationSchema = Schema.Struct({
  service: GoogleServiceIdSchema,
  scopes: Schema.Array(GoogleScopeSchema).check(
    Schema.isMaxLength(64),
    Schema.makeFilter((scopes) => {
      const expected = [...new Set(scopes)].sort()
      return scopes.every((scope, index) => scope === expected[index])
        ? undefined
        : "must contain sorted unique scopes"
    })
  ),
  status: GoogleAuthorizationStatusSchema
})

const GoogleAccountSchema = Schema.Struct({
  id: GoogleAccountIdSchema,
  email: GoogleEmailSchema,
  authorizations: Schema.Array(GoogleAuthorizationSchema).check(
    Schema.isMaxLength(3),
    Schema.makeFilter((authorizations) => {
      const expected = [...authorizations].sort((left, right) =>
        left.service.localeCompare(right.service)
      )
      return authorizations.every(
        (authorization, index) => authorization.service === expected[index]?.service
      ) &&
        new Set(authorizations.map((authorization) => authorization.service)).size ===
          authorizations.length
        ? undefined
        : "must contain sorted unique services"
    })
  )
})

export const GoogleAccountListResponseSchema = Schema.Struct({
  oauth_configured: Schema.Boolean,
  pending_oauth: Schema.Array(GoogleServiceIdSchema),
  accounts: Schema.Array(GoogleAccountSchema).check(
    Schema.makeFilter((accounts) => {
      const expected = [...accounts].sort((left, right) => left.email.localeCompare(right.email))
      return accounts.every((account, index) => account.id === expected[index]?.id) &&
        new Set(accounts.map((account) => account.id)).size === accounts.length &&
        new Set(accounts.map((account) => account.email)).size === accounts.length
        ? undefined
        : "must be sorted by email with unique ids and emails"
    })
  )
})

const GoogleAuthorizationUrlSchema = Schema.String.check(
  Schema.isMaxLength(8_192),
  Schema.makeFilter((value) => {
    const issue = serverUrlIssue(value, { http: PLAIN_HTTP.never })
    if (issue === SERVER_URL_ISSUE.invalid) return "must be an absolute HTTPS URL"
    return issue === undefined
      ? undefined
      : "must be an HTTPS URL without embedded credentials or a fragment"
  })
)

export const GoogleOAuthStartResponseSchema = Schema.Struct({
  service: GoogleServiceIdSchema,
  authorization_url: GoogleAuthorizationUrlSchema,
  expires_at: Schema.String,
  status: Schema.Literal("pending")
})

export const GoogleDisconnectReceiptSchema = Schema.Struct({
  status: Schema.Literal("removed"),
  service: GoogleServiceIdSchema,
  account_id: GoogleAccountIdSchema
})

const mapAuthorization = (
  authorization: typeof GoogleAuthorizationSchema.Type
): GoogleServiceAuthorization => ({
  service: authorization.service,
  scopes: authorization.scopes,
  status: authorization.status
})

const mapAccount = (account: typeof GoogleAccountSchema.Type): GoogleAccount => ({
  id: account.id,
  email: account.email,
  authorizations: account.authorizations.map(mapAuthorization)
})

export const toGoogleAccountList = (
  response: typeof GoogleAccountListResponseSchema.Type
): GoogleAccountListResponse => ({
  oauthConfigured: response.oauth_configured,
  pendingOAuth: response.pending_oauth,
  accounts: response.accounts.map(mapAccount)
})

export const toGoogleOAuthStart = (
  response: typeof GoogleOAuthStartResponseSchema.Type
): GoogleOAuthStartResponse => ({
  service: response.service,
  authorizationUrl: response.authorization_url,
  expiresAt: response.expires_at,
  status: response.status
})

export const toGoogleDisconnectReceipt = (
  response: typeof GoogleDisconnectReceiptSchema.Type
): GoogleDisconnectReceipt => ({
  status: response.status,
  service: response.service,
  accountId: response.account_id
})

export const encodeGoogleOAuthPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(GoogleServiceIdSchema)(value).pipe(
    Effect.map((service) => `${googlePath}/${encodeSegment(service)}/oauth`)
  )

export const GoogleGrantSchema = Schema.Literals(Object.values(GOOGLE_GRANT))

export const encodeGoogleGrantPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(Schema.Tuple([GoogleAccountIdSchema, GoogleGrantSchema]))(
    value,
    strict
  ).pipe(
    Effect.map(
      ([accountId, grant]) =>
        `${googlePath}/accounts/${encodeSegment(accountId)}/grants/${encodeSegment(grant)}`
    )
  )

export const encodeGoogleAccountPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(Schema.Tuple([GoogleServiceIdSchema, GoogleAccountIdSchema]))(
    value,
    strict
  ).pipe(
    Effect.map(
      ([service, accountId]) =>
        `${googlePath}/${encodeSegment(service)}/accounts/${encodeSegment(accountId)}`
    )
  )

export type GoogleAuthorizationStatusAgrees = Assert<
  Agrees<(typeof GoogleAuthorizationStatusSchema)["Type"], GoogleAuthorizationStatus>
>
