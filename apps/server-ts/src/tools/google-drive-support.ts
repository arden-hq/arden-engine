import type { GoogleToolConnections } from "./google-accounts.js"
import { Option, Schema } from "effect"

import type { EffectTarget } from "../execution/tool-effect.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { decodeOpaque } from "../lib/opaque-ref.js"
import { toolRefusal } from "./tool-failure.js"

export const DRIVE_API = "https://www.googleapis.com/drive/v3/files"
export const DOCS_API = "https://docs.googleapis.com/v1/documents"
export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
const DriveFileSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  mimeType: Schema.NonEmptyString,
  size: Schema.optionalKey(Schema.String),
  modifiedTime: Schema.optionalKey(Schema.String),
  webViewLink: Schema.optionalKey(Schema.String)
})

export const fileList = decodeGoogle(
  Schema.Struct({
    files: Schema.optionalKey(Schema.Array(DriveFileSchema)),
    nextPageToken: Schema.optionalKey(Schema.String),
    incompleteSearch: Schema.optionalKey(Schema.Boolean)
  }),
  { service: "google_drive", label: "file list" }
)

export const createdDocument = decodeGoogle(
  Schema.Struct({ documentId: Schema.NonEmptyString, title: Schema.optionalKey(Schema.String) }),
  { service: "google_drive", label: "document" }
)

export const createdSpreadsheet = decodeGoogle(
  Schema.Struct({
    spreadsheetId: Schema.NonEmptyString,
    spreadsheetUrl: Schema.optionalKey(Schema.String),
    properties: Schema.optionalKey(Schema.Struct({ title: Schema.optionalKey(Schema.String) }))
  }),
  { service: "google_drive", label: "spreadsheet" }
)

const DrivePageRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  fingerprint: Schema.String,
  token: Schema.String,
  account: Schema.String
})

const DocumentCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  document: Schema.String,
  tab: Schema.NullOr(Schema.String),
  digest: Schema.String,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

export const fileRef = (account: string, id: string): string => `${account}:${id}`

const rawGoogleFileId = (value: string): string | undefined => {
  const match = value.match(
    /^https:\/\/(?:docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/|drive\.google\.com\/file\/d\/)([A-Za-z0-9_-]+)(?:[/?#]|$)/u
  )
  if (match !== null) return match[1]
  return /^[A-Za-z0-9_-]{8,512}$/u.test(value) ? value : undefined
}

export const parseFileRef = (
  value: string
): { readonly accountRef?: string; readonly id: string } => {
  const rawId = rawGoogleFileId(value)
  if (rawId !== undefined) return { id: rawId }
  const separator = value.lastIndexOf(":")
  const accountRef = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (separator < 1 || !accountRef.includes("@") || !/^[A-Za-z0-9_-]{8,512}$/u.test(id)) {
    throw toolRefusal(
      "Use a Google Drive file URL or an exact file_ref returned by Drive tools.",
      "Invalid Drive reference"
    )
  }
  return { accountRef, id }
}

export const escapeDriveQuery = (value: string): string =>
  value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")

export const decodePageRef = (
  value: string | undefined,
  fingerprint: string,
  accountRef: string | undefined
): { readonly token?: string; readonly accountRef?: string } => {
  if (value === undefined) return accountRef === undefined ? {} : { accountRef }
  const decoded = Option.getOrUndefined(decodeOpaque(DrivePageRefSchema, value))
  if (
    decoded === undefined ||
    decoded.fingerprint !== fingerprint ||
    (accountRef !== undefined && accountRef !== decoded.account)
  )
    throw toolRefusal(
      "The Drive page_ref is invalid or belongs to another search.",
      "Invalid page reference"
    )
  return { token: decoded.token, accountRef: decoded.account }
}

export const readCursor = (
  value: string | undefined,
  expected: { readonly document: string; readonly tab: string | null; readonly digest: string }
): number => {
  if (value === undefined) return 0
  const cursor = Option.getOrUndefined(decodeOpaque(DocumentCursorSchema, value))
  if (
    cursor === undefined ||
    cursor.document !== expected.document ||
    cursor.tab !== expected.tab ||
    cursor.digest !== expected.digest
  )
    throw toolRefusal("The Google Doc cursor is invalid for this read.", "Invalid document cursor")
  return cursor.offset
}

export const documentUrl = (id: string): string =>
  `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`
export const spreadsheetUrl = (id: string): string =>
  `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`

export const MAX_FOUND_SOURCES = 50

const fileName = decodeGoogle(
  Schema.Struct({ name: Schema.NonEmptyString, webViewLink: Schema.optionalKey(Schema.String) }),
  { service: "google_drive", label: "file" }
)

export const namedFile = async ({
  google,
  ref,
  link,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly ref: { readonly accountRef?: string; readonly id: string }
  readonly link: (id: string) => string
  readonly signal: AbortSignal
}): Promise<EffectTarget> => {
  const url = new URL(`${DRIVE_API}/${encodeURIComponent(ref.id)}`)
  url.searchParams.set("fields", "name,webViewLink")
  const file = await googleCall({
    google,
    service: "google_drive",
    url: url.href,
    accountRef: ref.accountRef,
    signal
  })
    .then((response) => fileName(response.value))
    .catch(() => undefined)
  return {
    source: "google_drive",
    objectId: ref.id,
    ...(file === undefined ? {} : { title: file.name }),
    href: file?.webViewLink ?? link(ref.id)
  }
}
