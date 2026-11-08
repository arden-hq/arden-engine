import { Schema } from "effect"

import type { DriveUploadStore } from "../persistence/drive-uploads/store.js"
import { defineGoogleTool, type GoogleGrantDescription } from "./google-tool-grant.js"
import { parseFileRef } from "./google-drive.js"
import { readDriveFileMetadata } from "./google-drive-metadata.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { makeDriveDownloadTools } from "./google-drive-download.js"
import { makeDriveUploadTool } from "./google-drive-upload.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import type { SharedFileAccess } from "./shared-files.js"
import type { ServerTool } from "./define.js"
import { toolRefusal } from "./tool-failure.js"

const FileRefSchema = Schema.NonEmptyString.annotate({
  description:
    "Exact account-qualified file_ref from drive_search, a Drive upload, or a Calendar attachment."
})
const ShareParametersSchema = Schema.Struct({
  file_ref: FileRefSchema,
  recipient: Schema.String.check(
    Schema.isMinLength(3),
    Schema.isMaxLength(320),
    Schema.isPattern(/^[^@\s]+@[^@\s]+$/u)
  ),
  role: Schema.Literals(["reader", "writer"]).annotate({
    description: "Grant this person read or edit access. No public or domain sharing."
  })
})
const PermissionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  emailAddress: Schema.optionalKey(Schema.String)
})
const permissions = decodeGoogle(
  Schema.Struct({
    permissions: Schema.optionalKey(Schema.Array(PermissionSchema)),
    nextPageToken: Schema.optionalKey(Schema.String)
  }),
  { service: "google_drive", label: "file permissions" }
)
const permission = decodeGoogle(PermissionSchema, { service: "google_drive", label: "permission" })
const shareApproval = Schema.Struct({
  account: Schema.String,
  file_id: Schema.String,
  recipient: Schema.String,
  role: Schema.Literals(["reader", "writer"])
})

const SHARE_GRANT = {
  grant: "drive_manage",
  what: "change Drive file access",
  note: "Google requires Drive management access to grant access to existing files. Only the person and role shown on this card will be changed."
} as const satisfies GoogleGrantDescription

export const makeDriveFileTools = ({
  google,
  files,
  uploads
}: {
  readonly google: GoogleToolConnections
  readonly files: SharedFileAccess
  readonly uploads: DriveUploadStore["Service"]
}): ReadonlyArray<ServerTool> => [
  makeDriveUploadTool({ google, files, uploads }),
  ...makeDriveDownloadTools({ google, files }),
  defineGoogleTool({
    google,
    grant: {
      ...SHARE_GRANT,
      target: (input: typeof ShareParametersSchema.Type) => ({
        accountRef: parseFileRef(input.file_ref).accountRef
      })
    },
    name: "drive_share_file",
    description:
      "Explicitly grant one person read or edit access to a Drive file. Use separately from attaching the file to Calendar; attaching a link does not grant access. Existing equal or stronger access is left unchanged. Sends a Google sharing notification when granting new access. Requires the user's approval.",
    parameters: Schema.toStandardSchemaV1(ShareParametersSchema),
    metadata: {
      effect: "external",
      display_name: "Share Drive File",
      kind: "tool",
      action: "write",
      source: "google_drive",
      changes_state: true,
      concurrency_group: "drive_write",
      destructive: false,
      default_approval: "ask",
      always_ask: true,
      approval_preview: "Grant this person access to a Drive file.",
      policy_scope: "external",
      permissions: ["google_drive"],
      idempotent: true,
      target: "reported"
    },
    approvalPrompt: async (input, ctx) => {
      const file = await readDriveFileMetadata({
        google,
        fileRef: input.file_ref,
        signal: ctx.signal
      })
      return {
        preview: `Share ${file.name} with ${input.recipient}`,
        presentation: {
          title: "Share this Drive file?",
          approve_label: "Share",
          fields: [
            { label: "Account", value: file.account },
            { label: "File", value: file.name },
            { label: "Person", value: input.recipient },
            { label: "Access", value: input.role === "reader" ? "Read" : "Edit" }
          ],
          note: "This grants access to the live Drive file, including future edits."
        },
        data: {
          account: file.account,
          file_id: file.id,
          recipient: input.recipient.toLowerCase(),
          role: input.role
        }
      }
    },
    execute: async (input, ctx, effects) => {
      const approved = Schema.decodeUnknownOption(shareApproval)(ctx.approval?.data)
      const ref = parseFileRef(input.file_ref)
      if (
        approved._tag === "None" ||
        approved.value.file_id !== ref.id ||
        approved.value.recipient !== input.recipient.toLowerCase() ||
        approved.value.role !== input.role
      )
        throw toolRefusal(
          "Approve the exact file, person and access level before sharing.",
          "Sharing approval required"
        )
      const file = await readDriveFileMetadata({
        google,
        fileRef: input.file_ref,
        signal: ctx.signal
      })
      if (file.account !== approved.value.account)
        throw toolRefusal(
          "The sharing account changed after approval. Nothing was shared.",
          "Sharing account changed"
        )
      const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/permissions`
      let page: string | undefined
      let existing: typeof PermissionSchema.Type | undefined
      do {
        const url = new URL(endpoint)
        url.searchParams.set("fields", "nextPageToken,permissions(id,type,role,emailAddress)")
        url.searchParams.set("supportsAllDrives", "true")
        url.searchParams.set("pageSize", "100")
        if (page !== undefined) url.searchParams.set("pageToken", page)
        const response = await googleCall({
          google,
          service: "google_drive",
          url: url.href,
          accountRef: file.account,
          signal: ctx.signal
        })
        const body = permissions(response.value)
        existing = (body.permissions ?? []).find(
          (entry) =>
            entry.type === "user" &&
            entry.emailAddress?.toLowerCase() === input.recipient.toLowerCase()
        )
        page = existing === undefined ? body.nextPageToken : undefined
      } while (page !== undefined)
      if (
        existing !== undefined &&
        (existing.role === input.role ||
          (existing.role === "commenter" && input.role === "reader") ||
          ["owner", "organizer", "fileOrganizer", "writer"].includes(existing.role ?? ""))
      )
        return {
          result: `${input.recipient} already has the requested access to ${file.name}.`,
          preview: "File access unchanged",
          data: {
            file_ref: `${file.account}:${file.id}`,
            recipient: input.recipient,
            role: existing.role
          }
        }
      await effects.target({
        source: "google_drive",
        objectId: file.id,
        title: file.name,
        href: file.url
      })
      const url = new URL(
        existing === undefined ? endpoint : `${endpoint}/${encodeURIComponent(existing.id)}`
      )
      url.searchParams.set("supportsAllDrives", "true")
      url.searchParams.set("fields", "id,type,role,emailAddress")
      if (existing === undefined) url.searchParams.set("sendNotificationEmail", "true")
      const response = await googleCall({
        google,
        service: "google_drive",
        url: url.href,
        accountRef: file.account,
        signal: ctx.signal,
        effects,
        init: {
          method: existing === undefined ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            existing === undefined
              ? { type: "user", emailAddress: input.recipient, role: input.role }
              : { role: input.role }
          )
        }
      })
      const changed = permission(response.value)
      return {
        result: `Granted ${input.role === "reader" ? "read" : "edit"} access to ${input.recipient} for ${file.name}.`,
        preview: `Shared ${file.name}`,
        data: {
          file_ref: `${file.account}:${file.id}`,
          recipient: input.recipient,
          role: changed.role,
          permission_id: changed.id
        }
      }
    }
  })
]
