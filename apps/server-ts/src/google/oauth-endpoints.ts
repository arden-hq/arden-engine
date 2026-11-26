import type { GoogleServiceId } from "@arden-hq/protocol/google"

export interface GoogleEndpoints {
  readonly authorization: string
  readonly token: string
  readonly userInfo: string
}

export const DEFAULT_GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userInfo: "https://openidconnect.googleapis.com/v1/userinfo"
}

export const GOOGLE_SCOPES: Readonly<Record<GoogleServiceId, ReadonlyArray<string>>> = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
  ],
  google_drive: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
  ]
}
