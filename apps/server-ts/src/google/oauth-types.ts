import type { GoogleOAuthStartResponse, GoogleServiceId } from "@arden-hq/protocol/google"
import { type StoredAccount, type StoredAuthorization } from "./account-store.js"
import { type GoogleIncrementalGrant } from "./oauth.js"

export interface GoogleOAuth {
  readonly startOAuth: (
    service: GoogleServiceId,
    incremental?: GoogleIncrementalGrant
  ) => Promise<GoogleOAuthStartResponse>
  readonly refresh: (
    account: StoredAccount,
    authorization: StoredAuthorization
  ) => Promise<StoredAuthorization>
  readonly hasPending: () => boolean
  readonly pendingServices: () => GoogleServiceId[]
  readonly close: () => Promise<void>
}
