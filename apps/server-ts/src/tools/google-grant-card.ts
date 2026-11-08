import {
  googleAccountHasGrant,
  type GoogleAccount,
  type GoogleGrant,
  type GoogleServiceId
} from "@arden-hq/protocol/google"

import type { ServerApprovalPrompt } from "./define.js"
import { googleServiceAccount } from "./google-accounts.js"
import { DECISION_WORD } from "@arden-hq/protocol/permissions"

export type GrantAccess =
  | { readonly kind: "unknown" }
  | { readonly kind: "missing" | "allowed"; readonly account: GoogleAccount }

export const googleGrantAccess = (
  accounts: ReadonlyArray<GoogleAccount>,
  accountRef: string | undefined,
  service: GoogleServiceId,
  grant: GoogleGrant
): GrantAccess => {
  const account = googleServiceAccount({ accounts, accountRef, service })
  if (account === undefined) return { kind: "unknown" }
  const authorization = account.authorizations.find((item) => item.service === service)
  return authorization?.status === "ready" && !googleAccountHasGrant(account, grant)
    ? { kind: "missing", account }
    : { kind: "allowed", account }
}

export const withGrantNeed = (
  prompt: ServerApprovalPrompt,
  need: { readonly grant: GoogleGrant; readonly account: string; readonly note: string }
): ServerApprovalPrompt => ({
  ...prompt,
  ...(prompt.presentation === undefined
    ? {}
    : {
        presentation: {
          ...prompt.presentation,
          needs_grant: { grant: need.grant, account: need.account },
          note: need.note
        }
      })
})

export const grantReadCard = (input: {
  readonly grant: GoogleGrant
  readonly account: string
  readonly what: string
  readonly note: string
}): ServerApprovalPrompt =>
  withGrantNeed(
    {
      preview: `Let Arden ${input.what}`,
      presentation: {
        title: `Let Arden ${input.what}?`,
        approve_label: DECISION_WORD.allow,
        fields: [{ label: "Account", value: input.account }]
      }
    },
    input
  )
