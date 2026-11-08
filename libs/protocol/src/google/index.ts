import { decoderFor, projectedDecoderFor, runBoundary, strict } from "../common/boundary.js"
import {
  GoogleClientConfiguredSchema,
  GoogleDesktopClientFileSchema,
  GoogleOAuthCancelledSchema,
  GoogleClientReplacementSchema
} from "./client.js"
import type { GoogleGrant, GoogleServiceId } from "./contracts.js"
import {
  GoogleAccountListResponseSchema,
  GoogleDisconnectReceiptSchema,
  GoogleOAuthStartResponseSchema,
  encodeGoogleAccountPathEffect,
  encodeGoogleGrantPathEffect,
  encodeGoogleOAuthPathEffect,
  toGoogleAccountList,
  toGoogleDisconnectReceipt,
  toGoogleOAuthStart
} from "./schema.js"

export * from "./contracts.js"
export { GOOGLE_GRANTS, googleAccountHasGrant } from "./grants.js"
export { currentGmailUrl, gmailThreadUrl, gmailViewUrl } from "./gmail-links.js"
export { GoogleGrantSchema } from "./schema.js"

export const googleDecoders = {
  cancelled: decoderFor(GoogleOAuthCancelledSchema, "Invalid Google cancellation response", strict),
  replacement: decoderFor(
    GoogleClientReplacementSchema,
    "Invalid Google replacement response",
    strict
  ),
  clientFile: decoderFor(
    GoogleDesktopClientFileSchema,
    "Choose a Google Desktop app client file",
    strict
  ),
  configured: decoderFor(GoogleClientConfiguredSchema, "Invalid Google setup response", strict),
  accounts: projectedDecoderFor(
    GoogleAccountListResponseSchema,
    toGoogleAccountList,
    "Invalid Google account list",
    strict
  ),
  oauth: projectedDecoderFor(
    GoogleOAuthStartResponseSchema,
    toGoogleOAuthStart,
    "Invalid Google OAuth response",
    strict
  ),
  removed: projectedDecoderFor(
    GoogleDisconnectReceiptSchema,
    toGoogleDisconnectReceipt,
    "Invalid Google disconnect receipt",
    strict
  )
} as const

const oauthPath = (service: GoogleServiceId): string =>
  runBoundary(encodeGoogleOAuthPathEffect(service), "Invalid Google OAuth route", "encode")

const accountPath = (service: GoogleServiceId, accountId: string): string =>
  runBoundary(
    encodeGoogleAccountPathEffect([service, accountId]),
    "Invalid Google account route",
    "encode"
  )

const grantPath = (accountId: string, grant: GoogleGrant): string =>
  runBoundary(
    encodeGoogleGrantPathEffect([accountId, grant]),
    "Invalid Google grant route",
    "encode"
  )

export const googleRoutes = {
  accounts: "/google/accounts",
  client: "/google/client",
  cancelOAuth: "/google/oauth",
  replacement: "/google/client/replacement",
  oauth: oauthPath,
  disconnect: accountPath,
  /** POST: start Google consent for one optional grant on one connected account. */
  grant: grantPath
} as const
