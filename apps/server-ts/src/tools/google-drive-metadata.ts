import { Schema } from "effect"

import type { GoogleToolConnections } from "./google-accounts.js"
import { parseFileRef } from "./google-drive.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { toolRefusal } from "./tool-failure.js"

const DriveFileMetadataSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  mimeType: Schema.NonEmptyString,
  webViewLink: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.String),
  md5Checksum: Schema.optionalKey(Schema.String),
  appProperties: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  trashed: Schema.optionalKey(Schema.Boolean),
  capabilities: Schema.optionalKey(
    Schema.Struct({ canDownload: Schema.optionalKey(Schema.Boolean) })
  )
})

const decodeMetadata = decodeGoogle(DriveFileMetadataSchema, {
  service: "google_drive",
  label: "file metadata"
})

export interface DriveFileMetadata {
  readonly account: string
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly url: string
  readonly size?: number
  readonly md5Checksum?: string
  readonly appProperties?: Readonly<Record<string, string>>
  readonly trashed?: boolean
  readonly canDownload?: boolean
}

export const DRIVE_FILE_METADATA_FIELDS =
  "id,name,mimeType,webViewLink,size,md5Checksum,appProperties,trashed,capabilities(canDownload)"

export const decodeDriveFileMetadata = (value: unknown, account: string): DriveFileMetadata => {
  const file = decodeMetadata(value)
  const size = file.size === undefined ? undefined : Number(file.size)
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
    throw toolRefusal("Google Drive returned an invalid file size.", "Invalid Drive file")
  }
  const url =
    file.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`
  const parsed = URL.parse(url)
  if (
    parsed?.protocol !== "https:" ||
    !["drive.google.com", "docs.google.com"].includes(parsed.hostname)
  ) {
    throw toolRefusal("Google Drive returned an invalid file link.", "Invalid Drive file")
  }
  return {
    account,
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    url,
    ...(size === undefined ? {} : { size }),
    ...(file.md5Checksum === undefined ? {} : { md5Checksum: file.md5Checksum }),
    ...(file.appProperties === undefined ? {} : { appProperties: file.appProperties }),
    ...(file.trashed === undefined ? {} : { trashed: file.trashed }),
    ...(file.capabilities?.canDownload === undefined
      ? {}
      : { canDownload: file.capabilities.canDownload })
  }
}

export const readDriveFileMetadata = async ({
  google,
  fileRef,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly fileRef: string
  readonly signal: AbortSignal
}): Promise<DriveFileMetadata> => {
  const ref = parseFileRef(fileRef)
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ref.id)}`)
  url.searchParams.set("fields", DRIVE_FILE_METADATA_FIELDS)
  url.searchParams.set("supportsAllDrives", "true")
  const response = await googleCall({
    google,
    service: "google_drive",
    url: url.href,
    accountRef: ref.accountRef,
    signal
  })
  const file = decodeDriveFileMetadata(response.value, response.account.email)
  if (file.id !== ref.id || file.trashed === true) {
    throw toolRefusal(
      "This Drive file is unavailable or has been deleted.",
      "Drive file unavailable"
    )
  }
  return file
}
