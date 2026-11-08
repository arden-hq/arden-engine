import { sha256Hex } from "@arden-hq/std/hash"
import { canonicalJson } from "@arden-hq/std/json"
import { Option, Schema } from "effect"

import type { JsonObject } from "../persistence/json.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { CalendarAttachmentSchema } from "../google/calendar-client.js"
import { readDriveFileMetadata } from "./google-drive-metadata.js"
import { toolRefusal } from "./tool-failure.js"

export const CalendarAttachmentRefsSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
)
  .check(Schema.isMaxLength(25))
  .annotate({
    description:
      "Account-qualified Google Drive file_refs. Upload a local file with drive_upload first. Attaching a file does not grant guests access; use drive_share_file separately."
  })

export const CalendarRemoveAttachmentsSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
)
  .check(Schema.isMaxLength(25))
  .annotate({
    description:
      "Exact attachment_ref values returned by calendar_read_event to remove. Other attachments are preserved."
  })

type CalendarAttachment = typeof CalendarAttachmentSchema.Type

const ApprovedAttachmentsSchema = Schema.Struct({
  request_hash: Schema.String,
  attachments: Schema.Array(CalendarAttachmentSchema),
  target_id: Schema.optionalKey(Schema.String),
  etag: Schema.optionalKey(Schema.String)
})

type ApprovedAttachments = typeof ApprovedAttachmentsSchema.Type

export const calendarAttachmentRef = (attachment: CalendarAttachment): string =>
  attachment.fileId ?? attachment.fileUrl

export const calendarAttachmentBody = (attachments: ReadonlyArray<CalendarAttachment>) =>
  attachments.map(({ fileId: _fileId, ...writable }) => writable)

const mergeCalendarAttachments = ({
  current,
  add,
  remove
}: {
  readonly current: ReadonlyArray<CalendarAttachment>
  readonly add: ReadonlyArray<CalendarAttachment>
  readonly remove: ReadonlyArray<string>
}): ReadonlyArray<CalendarAttachment> => {
  const removed = new Set(remove)
  for (const ref of removed) {
    if (!current.some((item) => calendarAttachmentRef(item) === ref)) {
      throw toolRefusal(
        `This event has no attachment ${ref}. Read the event again before removing it.`,
        "Attachment changed"
      )
    }
  }
  const attachments = new Map(
    current
      .filter((item) => !removed.has(calendarAttachmentRef(item)))
      .map((item) => [calendarAttachmentRef(item), item])
  )
  for (const item of add) attachments.set(calendarAttachmentRef(item), item)
  if (attachments.size > 25) {
    throw toolRefusal(
      "A Calendar event can have at most 25 attachments. Remove one before adding more.",
      "Too many attachments"
    )
  }
  return [...attachments.values()]
}

interface AttachmentOperation {
  readonly google: GoogleToolConnections
  readonly request: unknown
  readonly refs: ReadonlyArray<string>
  readonly signal: AbortSignal
  readonly current?: {
    readonly id: string
    readonly etag?: string
    readonly attachments?: ReadonlyArray<CalendarAttachment>
  }
  readonly remove?: ReadonlyArray<string>
}

export const prepareCalendarAttachments = async ({
  google,
  request,
  refs,
  signal,
  current,
  remove = []
}: AttachmentOperation): Promise<ApprovedAttachments> => {
  const add: CalendarAttachment[] = []
  for (const ref of refs) {
    const file = await readDriveFileMetadata({ google, fileRef: ref, signal })
    if (file.mimeType === "application/vnd.google-apps.folder") {
      throw toolRefusal(
        `${file.name} is a folder. Choose a file to attach.`,
        "Cannot attach a folder"
      )
    }
    add.push({ fileId: file.id, fileUrl: file.url, title: file.name, mimeType: file.mimeType })
  }
  if (current !== undefined && current.etag === undefined) {
    throw toolRefusal(
      "Google Calendar did not return this event's version. Read the event again before changing attachments.",
      "Event version unavailable"
    )
  }
  return {
    request_hash: sha256Hex(canonicalJson(request, { lenient: true })),
    attachments: mergeCalendarAttachments({ current: current?.attachments ?? [], add, remove }),
    ...(current === undefined ? {} : { target_id: current.id, etag: current.etag })
  }
}

export const calendarAttachmentsForExecution = async (
  input: AttachmentOperation & {
    readonly approval: { readonly data?: JsonObject } | undefined
  }
): Promise<ApprovedAttachments> => {
  if (input.approval === undefined) return prepareCalendarAttachments(input)
  const saved = Option.getOrUndefined(
    Schema.decodeUnknownOption(ApprovedAttachmentsSchema)(
      input.approval.data?.["calendar_attachments"]
    )
  )
  if (
    saved === undefined ||
    saved.request_hash !== sha256Hex(canonicalJson(input.request, { lenient: true })) ||
    saved.target_id !== input.current?.id ||
    saved.etag !== input.current?.etag
  ) {
    throw toolRefusal(
      "The event or attachment request changed after approval. Read the event and request approval again; no attachment changes were sent.",
      "Attachment approval changed"
    )
  }
  return saved
}

export const calendarAttachmentPresentation = (attachments: ReadonlyArray<CalendarAttachment>) =>
  attachments.map((item) => ({
    kind: "link" as const,
    name: item.title ?? calendarAttachmentRef(item),
    media_type: item.mimeType ?? "application/octet-stream",
    url: item.fileUrl
  }))

export const CALENDAR_ATTACHMENT_ACCESS_NOTE =
  "These are links to Drive files. Guests keep their existing file access; use drive_share_file to grant access separately."
