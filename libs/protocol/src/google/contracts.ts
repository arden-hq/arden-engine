import type { JsonRecord } from "../common/json.js"

export type GoogleServiceId = "gmail" | "calendar" | "google_drive"
export interface GoogleAccountGrant extends JsonRecord {
  readonly account_id: string
  readonly service: GoogleServiceId
}

export type GoogleAuthorizationStatus = "ready" | "needs_auth"

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
  /** When the server stops listening for Google's answer; a wait ends here. */
  readonly expiresAt: string
  readonly status: "pending"
}

/**
 * A Google permission Arden asks for on first use, never when an account
 * connects (D12): connecting asks only for what every tool of that service
 * needs, and an account keeps working unchanged until someone uses the grant.
 */
export type GoogleGrant =
  | "gmail_drafts"
  | "gmail_modify"
  | "calendar_list"
  | "calendar_freebusy"
  | "drive_read"
  | "drive_manage"

export interface GoogleDisconnectReceipt extends JsonRecord {
  readonly status: "removed"
  readonly service: GoogleServiceId
  readonly accountId: string
}

/** A Google OAuth client the user configured for this device. */
export interface GoogleOAuthClient {
  readonly clientId: string
  readonly clientSecret?: string
}

/** Saving a client succeeds, or is blocked while accounts depend on the current one. */
export type GoogleClientConfigured =
  | { readonly status: "configured" }
  | { readonly status: "blocked"; readonly reason: "accounts_connected" | "authorization_pending" }

type GoogleAuthUri =
  | "https://accounts.google.com/o/oauth2/auth"
  | "https://accounts.google.com/o/oauth2/v2/auth"

/** The downloaded Desktop-app client file; endpoint fields cannot redirect credentials. */
export interface GoogleDesktopClientFile {
  readonly installed: {
    readonly client_id: string
    readonly client_secret: string
    readonly project_id?: string
    readonly auth_uri?: GoogleAuthUri
    readonly token_uri?: "https://oauth2.googleapis.com/token"
    readonly auth_provider_x509_cert_url?: "https://www.googleapis.com/oauth2/v1/certs"
    readonly redirect_uris?: ReadonlyArray<"http://localhost" | "http://127.0.0.1">
  }
}

/** The account holds a ready authorization for `service`: it can be used now, no sign-in first. */
export const accountReadyFor = (account: GoogleAccount, service: GoogleServiceId): boolean =>
  account.authorizations.some(
    (authorization) => authorization.service === service && authorization.status === "ready"
  )
