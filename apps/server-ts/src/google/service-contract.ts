import type {
  GoogleClientConfigured,
  GoogleOAuthClient,
  GoogleAccount,
  GoogleAccountListResponse,
  GoogleDisconnectReceipt,
  GoogleGrant,
  GoogleOAuthStartResponse,
  GoogleServiceId
} from "@arden-hq/protocol/google"
import { Effect } from "effect"

import type { CredentialVault } from "../credentials/vault.js"
import { GoogleConnectionError } from "./errors.js"
import { type GoogleEndpoints } from "./oauth-endpoints.js"
import { type GoogleApiRequest } from "./api-request.js"

export interface GoogleServiceOptions {
  readonly vault?: CredentialVault | undefined
  readonly oauthClient?: GoogleOAuthClient | undefined
  readonly endpoints?: Partial<GoogleEndpoints>
  readonly now?: () => number
  readonly random?: () => number
  readonly retrySleep?: (delayMs: number, signal: AbortSignal | undefined) => Promise<void>
}

export interface GoogleConnectionsShape {
  readonly cancelOAuth: () => Effect.Effect<{ readonly status: "cancelled" }, GoogleConnectionError>
  readonly prepareClientReplacement: (disconnectAccounts: boolean) => Effect.Effect<
    | { readonly status: "ready" }
    | {
        readonly status: "blocked"
        readonly reason: "accounts_connected" | "authorization_pending"
      },
    GoogleConnectionError
  >
  readonly configureClient: (
    client: GoogleOAuthClient
  ) => Effect.Effect<GoogleClientConfigured, GoogleConnectionError>
  readonly list: () => Effect.Effect<GoogleAccountListResponse, GoogleConnectionError>
  readonly accounts: () => ReadonlyArray<GoogleAccount>
  readonly startOAuth: (
    service: GoogleServiceId
  ) => Effect.Effect<GoogleOAuthStartResponse, GoogleConnectionError>
  readonly startGrantOAuth: (
    grant: GoogleGrant,
    accountId: string
  ) => Effect.Effect<GoogleOAuthStartResponse, GoogleConnectionError>
  readonly disconnect: (
    service: GoogleServiceId,
    accountId: string
  ) => Effect.Effect<GoogleDisconnectReceipt, GoogleConnectionError>
  readonly accessToken: (input: {
    readonly service: GoogleServiceId
    readonly accountRef?: string
    readonly forceRefresh?: boolean
  }) => Effect.Effect<
    { readonly account: GoogleAccount; readonly token: string },
    GoogleConnectionError
  >
  readonly verify: (
    service: GoogleServiceId,
    accountRef?: string
  ) => Effect.Effect<GoogleAccount, GoogleConnectionError>
  readonly request: (
    request: GoogleApiRequest
  ) => Effect.Effect<
    { readonly account: GoogleAccount; readonly value: unknown },
    GoogleConnectionError
  >
  readonly close: () => Promise<void>
}
