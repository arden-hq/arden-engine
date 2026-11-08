import type { GoogleAccount, GoogleGrant, GoogleServiceId } from "./contracts.js"

interface GoogleGrantScopes {
  readonly service: GoogleServiceId
  /** The scope Arden asks Google for. */
  readonly request: string
  /** Every scope that already allows the same calls; `request` is one of them. */
  readonly satisfiedBy: ReadonlyArray<string>
}

/**
 * The scopes behind each optional grant. `users.drafts.create` accepts
 * `gmail.compose`, `gmail.modify` or full mail access (Gmail API reference);
 * Arden asks only for `gmail.compose`. `users.threads.modify` and
 * `users.threads.trash` accept `gmail.modify` or full mail access.
 * `calendarList.list` and `.get` accept `calendar.calendarlist(.readonly)`,
 * `calendar.readonly` or `calendar`; `freebusy.query` accepts
 * `calendar.freebusy`, `calendar.events.freebusy`, `calendar.readonly` or
 * `calendar` (Calendar API reference).
 */
export const GOOGLE_GRANTS: Readonly<Record<GoogleGrant, GoogleGrantScopes>> = {
  drive_read: {
    service: "google_drive",
    request: "https://www.googleapis.com/auth/drive.readonly",
    satisfiedBy: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive"
    ]
  },
  drive_manage: {
    service: "google_drive",
    request: "https://www.googleapis.com/auth/drive",
    satisfiedBy: ["https://www.googleapis.com/auth/drive"]
  },
  gmail_drafts: {
    service: "gmail",
    request: "https://www.googleapis.com/auth/gmail.compose",
    satisfiedBy: [
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://mail.google.com/"
    ]
  },
  gmail_modify: {
    service: "gmail",
    request: "https://www.googleapis.com/auth/gmail.modify",
    satisfiedBy: ["https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"]
  },
  calendar_list: {
    service: "calendar",
    request: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    satisfiedBy: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar"
    ]
  },
  calendar_freebusy: {
    service: "calendar",
    request: "https://www.googleapis.com/auth/calendar.freebusy",
    satisfiedBy: [
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar"
    ]
  }
}

/** True when the account's authorization for the grant's service is ready and Google granted it. */
export const googleAccountHasGrant = (account: GoogleAccount, grant: GoogleGrant): boolean => {
  const { service, satisfiedBy } = GOOGLE_GRANTS[grant]
  const authorization = account.authorizations.find((item) => item.service === service)
  return (
    authorization !== undefined &&
    authorization.status === "ready" &&
    satisfiedBy.some((scope) => authorization.scopes.includes(scope))
  )
}
