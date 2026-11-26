import {
  GOOGLE_AUTHORIZATION_STATUS,
  GOOGLE_SERVICE_ID,
  type GoogleAccount,
  type GoogleGrant,
  type GoogleServiceId
} from "./contracts.js"

interface GoogleGrantScopes {
  readonly service: GoogleServiceId
  readonly request: string
  readonly satisfiedBy: ReadonlyArray<string>
}

export const GOOGLE_GRANTS: Readonly<Record<GoogleGrant, GoogleGrantScopes>> = {
  drive_read: {
    service: GOOGLE_SERVICE_ID.googleDrive,
    request: "https://www.googleapis.com/auth/drive.readonly",
    satisfiedBy: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive"
    ]
  },
  drive_manage: {
    service: GOOGLE_SERVICE_ID.googleDrive,
    request: "https://www.googleapis.com/auth/drive",
    satisfiedBy: ["https://www.googleapis.com/auth/drive"]
  },
  gmail_drafts: {
    service: GOOGLE_SERVICE_ID.gmail,
    request: "https://www.googleapis.com/auth/gmail.compose",
    satisfiedBy: [
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://mail.google.com/"
    ]
  },
  gmail_modify: {
    service: GOOGLE_SERVICE_ID.gmail,
    request: "https://www.googleapis.com/auth/gmail.modify",
    satisfiedBy: ["https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"]
  },
  calendar_list: {
    service: GOOGLE_SERVICE_ID.calendar,
    request: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    satisfiedBy: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar"
    ]
  },
  calendar_freebusy: {
    service: GOOGLE_SERVICE_ID.calendar,
    request: "https://www.googleapis.com/auth/calendar.freebusy",
    satisfiedBy: [
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar"
    ]
  }
}

export const googleAccountHasGrant = (account: GoogleAccount, grant: GoogleGrant): boolean => {
  const { service, satisfiedBy } = GOOGLE_GRANTS[grant]
  const authorization = account.authorizations.find((item) => item.service === service)
  return (
    authorization !== undefined &&
    authorization.status === GOOGLE_AUTHORIZATION_STATUS.ready &&
    satisfiedBy.some((scope) => authorization.scopes.includes(scope))
  )
}
