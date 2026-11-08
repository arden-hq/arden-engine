import {
  accountReadyFor,
  type GoogleServiceId,
  type GoogleAccount
} from "@arden-hq/protocol/google"

import { GOOGLE_SERVICE_NAMES } from "../google/recovery.js"
import type { GoogleConnections } from "../google/service.js"

export type GoogleToolConnections = Pick<GoogleConnections["Service"], "accounts" | "request">

const connectedAccounts = (
  google: Pick<GoogleToolConnections, "accounts">,
  service: GoogleServiceId
): ReadonlyArray<GoogleAccount> =>
  google.accounts().filter((account) => accountReadyFor(account, service))

export const connectedAccountEmails = (
  google: GoogleToolConnections,
  service: GoogleServiceId
): ReadonlyArray<string> => connectedAccounts(google, service).map((account) => account.email)

export const accountEmail = (google: GoogleToolConnections, accountRef: string): string =>
  google
    .accounts()
    .find(
      (account) =>
        account.id === accountRef || account.email.toLowerCase() === accountRef.toLowerCase()
    )?.email ?? accountRef

export const optionalAccountRefDescription = (
  service: GoogleServiceId,
  emails: ReadonlyArray<string>
): string => {
  const label = GOOGLE_SERVICE_NAMES[service].label
  if (emails.length === 0) return `${label} account email or id. No ${label} account is connected.`
  if (emails.length === 1) {
    return `${label} account email or id. Connected: ${emails[0]}. Omit it; that account is used.`
  }
  return `${label} account email or id. Connected: ${emails.join(", ")}. Required; pass one of them.`
}

export const requiredAccountRefDescription = (
  service: GoogleServiceId,
  lead: string,
  emails: ReadonlyArray<string>
): string => {
  const label = GOOGLE_SERVICE_NAMES[service].label
  if (emails.length === 0) return `${lead} No ${label} account is connected.`
  return `${lead} Connected: ${emails.join(", ")}.`
}

export const googleServiceAccount = ({
  accounts,
  accountRef,
  service
}: {
  readonly accounts: ReadonlyArray<GoogleAccount>
  readonly accountRef: string | undefined
  readonly service: GoogleServiceId
}): GoogleAccount | undefined => {
  const connected = accounts.filter((account) =>
    account.authorizations.some((item) => item.service === service)
  )
  if (accountRef === undefined) return connected.length === 1 ? connected[0] : undefined
  return connected.find(
    (account) =>
      account.id === accountRef || account.email.toLowerCase() === accountRef.toLowerCase()
  )
}
