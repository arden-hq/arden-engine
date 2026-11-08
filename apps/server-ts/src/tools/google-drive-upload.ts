import { formatBytes } from "@arden-hq/std/count"
import { errorMessage } from "@arden-hq/std/errors"
import { sha256Hex } from "@arden-hq/std/hash"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"

import type {
  DriveUploadKey,
  DriveUploadReservation,
  DriveUploadStore
} from "../persistence/drive-uploads/store.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { accountEmail, type GoogleToolConnections } from "./google-accounts.js"
import { decodeDriveFileMetadata, DRIVE_FILE_METADATA_FIELDS } from "./google-drive-metadata.js"
import { decodeGoogle, googleCall, googleToolFailure } from "./google-request.js"
import {
  FileRefSchema,
  PreparedFileSchema,
  preparedFilesApproval,
  type SharedFileAccess,
  type PreparedFile
} from "./shared-files.js"
import type { ServerRunContext } from "./run-context.js"
import { PauseRequested, type ToolContext } from "@arden-hq/loop"
import { toolRefusal } from "./tool-failure.js"

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const UploadParametersSchema = Schema.Struct({
  account_ref: Schema.NonEmptyString.annotate({
    description: "Connected Google Drive account email or id."
  }),
  file: FileRefSchema,
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  folder_id: Schema.optionalKey(
    Schema.NonEmptyString.annotate({ description: "Destination folder id. Omit for My Drive." })
  ),
  operation_key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
    description:
      "Stable name for this upload within this chat and account. Reuse it on retry; a changed upload needs a new key."
  })
})
type UploadInput = typeof UploadParametersSchema.Type
type Ctx = ToolContext<ServerRunContext>
interface UploadServices {
  readonly google: GoogleToolConnections
  readonly files: SharedFileAccess
  readonly uploads: DriveUploadStore["Service"]
}
const savedFiles = Schema.fromJsonString(Schema.Array(PreparedFileSchema))
const generatedIds = decodeGoogle(
  Schema.Struct({
    ids: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(1))
  }),
  { service: "google_drive", label: "reserved file id" }
)
const approval = Schema.Struct({
  request_hash: Schema.String,
  intent_hash: Schema.String,
  remote_file_id: Schema.String
})

const keyFor = (google: GoogleToolConnections, input: UploadInput, ctx: Ctx): DriveUploadKey => ({
  sessionId: ctx.run.sessionId,
  account: accountEmail(google, input.account_ref).toLowerCase(),
  operationKey: input.operation_key
})
const requestHash = (input: UploadInput, key: DriveUploadKey): string =>
  sha256Hex(
    JSON.stringify({
      account: key.account,
      file: input.file,
      name: input.name ?? null,
      folder: input.folder_id ?? null,
      operation: key.operationKey
    })
  )
const decodeFiles = (record: DriveUploadReservation): ReadonlyArray<PreparedFile> => {
  const result = Schema.decodeUnknownOption(savedFiles)(record.snapshotJson)
  if (result._tag === "None" || result.value.length !== 1)
    throw toolRefusal(
      "The saved Drive upload file is unavailable. Nothing was uploaded.",
      "Drive upload unavailable"
    )
  return result.value
}
const requireRequest = (record: DriveUploadReservation, hash: string): void => {
  if (record.requestHash !== hash)
    throw toolRefusal(
      "This upload name already belongs to another file or destination. Retry the original request, or use a new operation_key for a different upload.",
      "Upload request changed"
    )
}

const reserve = async (
  services: UploadServices,
  input: UploadInput,
  ctx: Ctx
): Promise<DriveUploadReservation> => {
  const key = keyFor(services.google, input, ctx)
  const hash = requestHash(input, key)
  const existing = await Effect.runPromise(services.uploads.get(key), { signal: ctx.signal })
  if (existing !== undefined) {
    requireRequest(existing, hash)
    return existing
  }
  const files = await services.files.prepare({
    ctx,
    refs: [input.file],
    key: `drive-upload:${key.account}:${key.operationKey}`,
    maxBytes: MAX_UPLOAD_BYTES
  })
  const file = files[0]
  if (file === undefined) throw toolRefusal("Choose one file to upload.", "No upload file")
  const intentHash = sha256Hex(
    JSON.stringify({
      account: key.account,
      name: input.name ?? file.name,
      folder: input.folder_id ?? null,
      mediaType: uploadMime(file.media_type),
      sha256: file.sha256,
      size: file.size
    })
  )
  const response = await googleCall({
    google: services.google,
    service: "google_drive",
    url: "https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files",
    accountRef: key.account,
    signal: ctx.signal
  })
  const id = generatedIds(response.value).ids[0]
  if (id === undefined)
    throw toolRefusal("Google Drive did not reserve an upload id.", "Upload unavailable")
  const record = await Effect.runPromise(
    services.uploads.reserve({
      ...key,
      requestHash: hash,
      intentHash,
      remoteFileId: id,
      snapshotJson: JSON.stringify(files)
    }),
    { signal: ctx.signal }
  )
  requireRequest(record, hash)
  return record
}

const existingRemote = async (
  services: UploadServices,
  record: DriveUploadReservation,
  signal: AbortSignal
) => {
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.remoteFileId)}`
  )
  url.searchParams.set("fields", DRIVE_FILE_METADATA_FIELDS)
  url.searchParams.set("supportsAllDrives", "true")
  return Effect.runPromise(
    services.google
      .request({
        service: "google_drive",
        url: url.href,
        accountRef: record.account,
        init: { signal }
      })
      .pipe(
        Effect.map((response) => decodeDriveFileMetadata(response.value, response.account.email)),
        Effect.catch((error) =>
          error.diagnostic.kind === "http" && error.diagnostic.status === 404
            ? Effect.succeed(undefined)
            : Effect.fail(googleToolFailure(error, "google_drive", record.account))
        )
      ),
    { signal }
  )
}

const uploadMime = (value: string): string => {
  const mime = value.split(";")[0]?.trim() ?? ""
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mime))
    throw toolRefusal(
      "This file has an invalid media type and cannot be uploaded.",
      "Unsupported file type"
    )
  return mime
}

const checkRemote = async (
  services: UploadServices,
  record: DriveUploadReservation,
  file: PreparedFile,
  input: UploadInput,
  remote: NonNullable<Awaited<ReturnType<typeof existingRemote>>>,
  signal: AbortSignal
): Promise<void> => {
  if (
    remote.trashed === true ||
    remote.appProperties?.["ardenUploadIntent"] !== record.intentHash ||
    remote.size !== file.size ||
    remote.name !== (input.name ?? file.name) ||
    remote.mimeType !== uploadMime(file.media_type)
  ) {
    throw toolRefusal(
      "The reserved Drive file was deleted or changed. Arden will not replace it or create a duplicate. Use a new operation_key only if you want a new upload.",
      "Drive upload changed"
    )
  }
  const content = await googleCall({
    google: services.google,
    service: "google_drive",
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.remoteFileId)}?alt=media&supportsAllDrives=true`,
    accountRef: record.account,
    signal,
    response: { kind: "binary", maxBytes: MAX_UPLOAD_BYTES }
  })
  if (!(content.value instanceof Uint8Array) || sha256Hex(content.value) !== file.sha256)
    throw toolRefusal(
      "The Drive file no longer contains the approved bytes. Nothing was replaced or uploaded.",
      "Drive file changed"
    )
}

export const makeDriveUploadTool = (services: UploadServices): ServerTool =>
  defineServerTool({
    name: "drive_upload",
    description:
      "Upload one chat attachment, generated artifact, or allowed local file to Google Drive. The card saves the exact bytes to upload. Reuse operation_key for retries, including after a lost response; it never creates a second file. Returns metadata and file_ref, not file contents.",
    parameters: Schema.toStandardSchemaV1(UploadParametersSchema),
    metadata: {
      effect: "external",
      display_name: "Upload Drive File",
      kind: "tool",
      action: "write",
      source: "google_drive",
      changes_state: true,
      concurrency_group: "drive_write",
      destructive: false,
      default_approval: "ask",
      always_ask: true,
      approval_preview: "Upload this file to Google Drive.",
      policy_scope: "external",
      permissions: ["google_drive"],
      idempotent: true,
      target: "reported"
    },
    approvalPrompt: async (input, ctx) => {
      const record = await reserve(services, input, ctx)
      const files = decodeFiles(record)
      const file = files[0]
      if (file === undefined)
        throw toolRefusal("The upload file is unavailable.", "Upload unavailable")
      return {
        preview: `Upload ${input.name ?? file.name} to Drive`,
        presentation: {
          title: "Upload this file to Google Drive?",
          approve_label: "Upload",
          fields: [
            { label: "Account", value: record.account },
            { label: "File", value: `${input.name ?? file.name} · ${formatBytes(file.size)}` },
            { label: "Folder", value: input.folder_id ?? "My Drive" }
          ],
          note: "Only the saved copy shown here will be uploaded. File access is unchanged."
        },
        data: {
          request_hash: record.requestHash,
          intent_hash: record.intentHash,
          remote_file_id: record.remoteFileId,
          shared_files: preparedFilesApproval({
            key: `drive-upload:${record.account}:${record.operationKey}`,
            refs: [input.file],
            files,
            intent: { request_hash: record.requestHash, intent_hash: record.intentHash }
          })
        }
      }
    },
    execute: async (input, ctx, effects) => {
      const approved = Schema.decodeUnknownOption(approval)(ctx.approval?.data)
      if (approved._tag === "None")
        throw toolRefusal(
          "Approve this upload before it sends the file to Google Drive.",
          "Upload approval required"
        )
      const key = keyFor(services.google, input, ctx)
      const record = await Effect.runPromise(services.uploads.get(key), { signal: ctx.signal })
      if (record === undefined)
        throw toolRefusal(
          "The saved upload record is missing. Nothing was uploaded.",
          "Upload unavailable"
        )
      requireRequest(record, requestHash(input, key))
      if (
        approved.value.request_hash !== record.requestHash ||
        approved.value.intent_hash !== record.intentHash ||
        approved.value.remote_file_id !== record.remoteFileId
      )
        throw toolRefusal(
          "The upload approval belongs to a different file or destination.",
          "Upload approval changed"
        )
      const files = decodeFiles(record)
      const file = files[0]
      if (file === undefined)
        throw toolRefusal("The saved upload file is unavailable.", "Upload unavailable")
      await effects.target(
        { source: "google_drive", objectId: record.remoteFileId, title: input.name ?? file.name },
        { creates: true }
      )
      const previous = await existingRemote(services, record, ctx.signal)
      if (previous !== undefined) {
        await checkRemote(services, record, file, input, previous, ctx.signal)
        await Effect.runPromise(services.uploads.confirm(key), { signal: ctx.signal })
        effects.applied()
        return {
          result: `The file is already uploaded: ${previous.name}.`,
          preview: `Uploaded ${previous.name}`,
          data: {
            file_ref: `${record.account}:${record.remoteFileId}`,
            name: previous.name,
            mime_type: previous.mimeType,
            byte_length: file.size,
            sha256: file.sha256,
            url: previous.url
          }
        }
      }
      if (record.status === "confirmed")
        throw toolRefusal(
          "The previously uploaded Drive file is missing. Arden will not create another file on retry.",
          "Drive file unavailable"
        )
      const content = (await services.files.read({ ctx, files, maxBytes: MAX_UPLOAD_BYTES }))[0]
      if (content === undefined)
        throw toolRefusal(
          "The saved file is unavailable. Nothing was uploaded.",
          "Upload file unavailable"
        )
      let boundary = `arden-${randomUUID()}`
      while (content.bytes.includes(boundary)) boundary += "x"
      const metadata = {
        id: record.remoteFileId,
        name: input.name ?? file.name,
        mimeType: uploadMime(file.media_type),
        appProperties: { ardenUploadIntent: record.intentHash },
        ...(input.folder_id === undefined ? {} : { parents: [input.folder_id] })
      }
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${uploadMime(file.media_type)}\r\n\r\n`
        ),
        content.bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
      const url = new URL("https://www.googleapis.com/upload/drive/v3/files")
      url.searchParams.set("uploadType", "multipart")
      url.searchParams.set("supportsAllDrives", "true")
      url.searchParams.set("fields", DRIVE_FILE_METADATA_FIELDS)
      try {
        const response = await googleCall({
          google: services.google,
          service: "google_drive",
          url: url.href,
          init: {
            method: "POST",
            headers: { "content-type": `multipart/related; boundary=${boundary}` },
            body
          },
          accountRef: record.account,
          signal: ctx.signal,
          effects
        })
        const created = decodeDriveFileMetadata(response.value, record.account)
        if (created.id !== record.remoteFileId)
          throw toolRefusal(
            "Google Drive returned a different file id. Check the reserved file before retrying.",
            "Unexpected Drive file"
          )
        await Effect.runPromise(services.uploads.confirm(key), { signal: ctx.signal })
        return {
          result: `Uploaded ${created.name} to Google Drive.`,
          preview: `Uploaded ${created.name}`,
          data: {
            file_ref: `${record.account}:${created.id}`,
            name: created.name,
            mime_type: created.mimeType,
            byte_length: file.size,
            sha256: file.sha256,
            url: created.url
          }
        }
      } catch (cause) {
        if (ctx.signal.aborted || cause instanceof PauseRequested) throw cause
        throw toolRefusal(
          `${errorMessage(cause)} Retry the same request with operation_key "${record.operationKey}"; Arden will check and reuse file ${record.remoteFileId}, without creating a duplicate.`,
          "Drive upload not confirmed"
        )
      }
    }
  })
