export const GOOGLE_MIME = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder"
} as const

type GoogleMime = (typeof GOOGLE_MIME)[keyof typeof GOOGLE_MIME]

export const DRIVE_FILE_KIND = {
  document: "document",
  spreadsheet: "spreadsheet",
  folder: "folder",
  presentation: "presentation",
  file: "file"
} as const

type DriveFileKind = (typeof DRIVE_FILE_KIND)[keyof typeof DRIVE_FILE_KIND]

export const SEARCH_MIME_QUERY = {
  any: "",
  document: `mimeType='${GOOGLE_MIME.document}'`,
  spreadsheet: `mimeType='${GOOGLE_MIME.spreadsheet}'`
} as const

const KIND_OF_MIME: Readonly<Record<GoogleMime, DriveFileKind>> = {
  [GOOGLE_MIME.document]: DRIVE_FILE_KIND.document,
  [GOOGLE_MIME.spreadsheet]: DRIVE_FILE_KIND.spreadsheet,
  [GOOGLE_MIME.folder]: DRIVE_FILE_KIND.folder,
  [GOOGLE_MIME.presentation]: DRIVE_FILE_KIND.presentation
}

const isGoogleMime = (mimeType: string): mimeType is GoogleMime =>
  Object.hasOwn(KIND_OF_MIME, mimeType)

export const driveFileKind = (mimeType: string): DriveFileKind =>
  isGoogleMime(mimeType) ? KIND_OF_MIME[mimeType] : DRIVE_FILE_KIND.file
