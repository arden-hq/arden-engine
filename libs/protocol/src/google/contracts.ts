import type { JsonRecord } from "../common/json.js"

export const GOOGLE_SERVICE_ID = {
  gmail: "gmail",
  calendar: "calendar",
  googleDrive: "google_drive"
} as const

export type GoogleServiceId = (typeof GOOGLE_SERVICE_ID)[keyof typeof GOOGLE_SERVICE_ID]

export interface GoogleAccountGrant extends JsonRecord {
  readonly account_id: string
  readonly service: GoogleServiceId
}

export const GOOGLE_AUTHORIZATION_STATUS = { ready: "ready", needsAuth: "needs_auth" } as const

export type GoogleAuthorizationStatus =
  (typeof GOOGLE_AUTHORIZATION_STATUS)[keyof typeof GOOGLE_AUTHORIZATION_STATUS]

export interface GoogleServiceAuthorization extends JsonRecord {
  readonly service: GoogleServiceId
  readonly scopes: ReadonlyArray<string>
  readonly status: GoogleAuthorizationStatus
}

export interface GoogleAccount extends JsonRecord {
  readonly id: string
  readonly email: string
  readonly authorizations: ReadonlyArray<GoogleServiceAuthorization>
}

export interface GoogleAccountListResponse extends JsonRecord {
  readonly pendingOAuth: ReadonlyArray<GoogleServiceId>
  readonly oauthConfigured: boolean
  readonly accounts: ReadonlyArray<GoogleAccount>
}

export interface GoogleOAuthStartResponse extends JsonRecord {
  readonly service: GoogleServiceId
  readonly authorizationUrl: string
  readonly expiresAt: string
  readonly status: "pending"
}

export const GOOGLE_GRANT = {
  gmailDrafts: "gmail_drafts",
  gmailModify: "gmail_modify",
  calendarList: "calendar_list",
  calendarFreebusy: "calendar_freebusy",
  driveRead: "drive_read",
  driveManage: "drive_manage"
} as const

export type GoogleGrant = (typeof GOOGLE_GRANT)[keyof typeof GOOGLE_GRANT]

export interface GoogleDisconnectReceipt extends JsonRecord {
  readonly status: "removed"
  readonly service: GoogleServiceId
  readonly accountId: string
}

export const GOOGLE_CLIENT_SECRET = { public: "public", confidential: "confidential" } as const

export type GoogleClientSecret =
  | { readonly kind: typeof GOOGLE_CLIENT_SECRET.public }
  | { readonly kind: typeof GOOGLE_CLIENT_SECRET.confidential; readonly clientSecret: string }

export interface GoogleOAuthClient {
  readonly clientId: string
  readonly secret: GoogleClientSecret
}

export const sameGoogleClient = (left: GoogleOAuthClient, right: GoogleOAuthClient): boolean =>
  left.clientId === right.clientId &&
  (left.secret.kind === GOOGLE_CLIENT_SECRET.confidential
    ? right.secret.kind === GOOGLE_CLIENT_SECRET.confidential &&
      left.secret.clientSecret === right.secret.clientSecret
    : right.secret.kind === GOOGLE_CLIENT_SECRET.public)

export const GOOGLE_CLIENT_BLOCK = {
  accountsConnected: "accounts_connected",
  authorizationPending: "authorization_pending"
} as const

export type GoogleClientBlock = (typeof GOOGLE_CLIENT_BLOCK)[keyof typeof GOOGLE_CLIENT_BLOCK]

export const GOOGLE_CLIENT_CONFIGURED = { configured: "configured", blocked: "blocked" } as const

export type GoogleClientConfigured =
  | { readonly status: typeof GOOGLE_CLIENT_CONFIGURED.configured }
  | { readonly status: typeof GOOGLE_CLIENT_CONFIGURED.blocked; readonly reason: GoogleClientBlock }

export const GOOGLE_CLIENT_REPLACEMENT = { ready: "ready", blocked: "blocked" } as const

export type GoogleClientReplacement =
  | { readonly status: typeof GOOGLE_CLIENT_REPLACEMENT.ready }
  | {
      readonly status: typeof GOOGLE_CLIENT_REPLACEMENT.blocked
      readonly reason: GoogleClientBlock
    }

type GoogleAuthUri =
  | "https://accounts.google.com/o/oauth2/auth"
  | "https://accounts.google.com/o/oauth2/v2/auth"

export interface GoogleDesktopClientFile {
  readonly installed: {
    readonly client_id: string
    readonly client_secret: string
    readonly project_id: string
    readonly auth_uri: GoogleAuthUri
    readonly token_uri: "https://oauth2.googleapis.com/token"
    readonly auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs"
    readonly redirect_uris: ReadonlyArray<"http://localhost" | "http://127.0.0.1">
  }
}

export const accountReadyFor = (account: GoogleAccount, service: GoogleServiceId): boolean =>
  account.authorizations.some(
    (authorization) =>
      authorization.service === service &&
      authorization.status === GOOGLE_AUTHORIZATION_STATUS.ready
  )
