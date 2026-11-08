import { sha256Hex } from "@arden-hq/std/hash"
import { Schema } from "effect"

import { defineGoogleTool, type GoogleGrantDescription } from "./google-tool-grant.js"
import { parseFileRef } from "./google-drive.js"
import { readDriveFileMetadata } from "./google-drive-metadata.js"
import { googleCall } from "./google-request.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import type { SharedFileAccess } from "./shared-files.js"
import type { ServerTool } from "./define.js"
import { toolRefusal } from "./tool-failure.js"

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const MAX_EXPORT_BYTES = 10 * 1024 * 1024
const FileRefSchema = Schema.NonEmptyString.annotate({
  description:
    "Exact account-qualified file_ref from drive_search, a Drive upload, or a Calendar attachment."
})
const ExportMimeSchema = Schema.Literals([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/html"
])
const DownloadParametersSchema = Schema.Struct({ file_ref: FileRefSchema })
const ExportParametersSchema = Schema.Struct({
  file_ref: FileRefSchema,
  export_mime_type: ExportMimeSchema
})
const READ_GRANT = {
  grant: "drive_read",
  what: "read and download Drive files",
  note: "Approving asks Google for read-only access to Drive file contents. It does not allow edits or sharing."
} as const satisfies GoogleGrantDescription

const exportExtension = (
  sourceMime: string,
  targetMime: string | undefined
): string | undefined => {
  if (!sourceMime.startsWith("application/vnd.google-apps.")) {
    if (targetMime !== undefined)
      throw toolRefusal(
        "This is an ordinary file. Omit export_mime_type to download its original bytes.",
        "Export not supported"
      )
    return undefined
  }
  if (targetMime === undefined)
    throw toolRefusal(
      "Choose export_mime_type to download this Google document, such as application/pdf.",
      "Choose an export format"
    )
  const formats: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "application/vnd.google-apps.document": {
      "application/pdf": "pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "text/plain": "txt",
      "text/html": "html"
    },
    "application/vnd.google-apps.spreadsheet": {
      "application/pdf": "pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "text/csv": "csv",
      "text/tab-separated-values": "tsv"
    },
    "application/vnd.google-apps.presentation": {
      "application/pdf": "pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "text/plain": "txt"
    }
  }
  const extension = formats[sourceMime]?.[targetMime]
  if (extension === undefined)
    throw toolRefusal(
      "This Google file cannot be exported to that format. Docs support PDF, DOCX, TXT or HTML; Sheets support PDF, XLSX, CSV or TSV; Slides support PDF, PPTX or TXT. CSV and TSV export only the first sheet.",
      "Unsupported export format"
    )
  return extension
}

export const makeDriveDownloadTools = ({
  google,
  files
}: {
  readonly google: GoogleToolConnections
  readonly files: SharedFileAccess
}): ReadonlyArray<ServerTool> =>
  [false, true].map((exportFile) => {
    const ParametersSchema = exportFile ? ExportParametersSchema : DownloadParametersSchema
    return defineGoogleTool({
      google,
      grant: {
        ...READ_GRANT,
        target: (input: typeof ParametersSchema.Type) => ({
          accountRef: parseFileRef(input.file_ref).accountRef
        })
      },
      name: exportFile ? "drive_export" : "drive_download",
      description: exportFile
        ? "Export a native Google Doc, Sheet or Slide to a chosen file format, up to 10 MiB. Search lists metadata first; export only when content is needed. Returns a reusable artifact_ref and metadata, never base64 file contents. CSV and TSV export only the first sheet."
        : "Download an ordinary Drive file, up to 100 MiB, only when its content is needed. Search and Calendar reads list metadata first. Returns a reusable artifact_ref, filename, MIME type, size and digest. Use drive_export for native Google Docs, Sheets and Slides.",
      parameters: Schema.toStandardSchemaV1(ParametersSchema),
      metadata: {
        effect: "local_files",
        display_name: exportFile ? "Export Drive File" : "Download Drive File",
        kind: "tool",
        action: "write",
        source: "google_drive",
        changes_state: true,
        concurrency_group: "conversation_artifacts",
        destructive: false,
        default_approval: "approve",
        approval_preview: "Save a Drive file as a reusable chat attachment.",
        policy_scope: "external",
        permissions: ["google_drive"],
        idempotent: true,
        target: "reported"
      },
      execute: async (input, ctx, effects) => {
        const file = await readDriveFileMetadata({
          google,
          fileRef: input.file_ref,
          signal: ctx.signal
        })
        if (file.canDownload === false)
          throw toolRefusal(
            "Google Drive does not allow this account to download this file. Ask its owner for download access.",
            "Download permission denied"
          )
        if (file.mimeType === "application/vnd.google-apps.folder")
          throw toolRefusal(
            "A Drive folder cannot be downloaded as one file with this tool. Search for and download its files individually.",
            "Choose a file"
          )
        const exportMime =
          "export_mime_type" in input && typeof input.export_mime_type === "string"
            ? input.export_mime_type
            : undefined
        if (!exportFile && file.mimeType.startsWith("application/vnd.google-apps."))
          throw toolRefusal(
            "Use drive_export and choose a format to download this native Google document.",
            "Choose an export format"
          )
        if (exportFile && !file.mimeType.startsWith("application/vnd.google-apps."))
          throw toolRefusal(
            "Use drive_download for this ordinary file; it does not need exporting.",
            "Export not supported"
          )
        const extension = exportExtension(file.mimeType, exportMime)
        const limit = extension === undefined ? MAX_DOWNLOAD_BYTES : MAX_EXPORT_BYTES
        if (extension === undefined && file.size !== undefined && file.size > limit)
          throw toolRefusal(
            "This Drive file exceeds 100 MiB and cannot be downloaded by Arden.",
            "File too large"
          )
        const url = new URL(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}${extension === undefined ? "" : "/export"}`
        )
        if (extension === undefined) {
          url.searchParams.set("alt", "media")
          url.searchParams.set("supportsAllDrives", "true")
        } else url.searchParams.set("mimeType", exportMime ?? "application/pdf")
        const response = await googleCall({
          google,
          service: "google_drive",
          url: url.href,
          accountRef: file.account,
          signal: ctx.signal,
          response: { kind: "binary", maxBytes: limit }
        })
        if (!(response.value instanceof Uint8Array))
          throw toolRefusal("Google Drive did not return file bytes.", "Invalid download")
        const sha256 = sha256Hex(response.value)
        const filename = extension === undefined ? file.name : `${file.name}.${extension}`
        const mediaType = exportMime ?? file.mimeType
        const identity = sha256Hex(
          JSON.stringify({ sha256, filename, mediaType, title: file.name })
        )
        const saved = await files.publish({
          ctx,
          key: `drive-download:${file.account}:${file.id}:${identity}`,
          name: filename,
          bytes: Buffer.from(response.value),
          mediaType
        })
        if (saved.kind !== "snapshot")
          throw toolRefusal("The downloaded file could not be saved.", "Download unavailable")
        effects.applied()
        return {
          result: `Saved ${saved.name}. Reuse artifact_ref ${saved.artifact_ref} in email, Drive, or browser uploads.`,
          preview: `Downloaded ${saved.name}`,
          data: {
            artifact_ref: saved.artifact_ref,
            file_ref: `${file.account}:${file.id}`,
            filename: saved.name,
            mime_type: saved.media_type,
            byte_length: saved.size,
            sha256: saved.sha256
          }
        }
      }
    })
  })
