import type { ApprovalPresentation } from "@arden-hq/protocol/chat"
import { toolRefusal } from "./tool-failure.js"
import type { ToolContext } from "@arden-hq/loop"
import { Schema } from "effect"

import type { JsonObject } from "../persistence/json.js"
import type { ServerRunContext } from "./run-context.js"
import { MAX_EMAIL_ATTACHMENT_BYTES, type MessageAttachment } from "./google-gmail-mime.js"
import {
  FileRefSchema,
  preparedFilesApproval,
  type FileRef,
  type SharedFileAccess
} from "./shared-files.js"

export const EmailAttachmentsSchema = Schema.optionalKey(
  Schema.Array(FileRefSchema).check(Schema.isMaxLength(100)).annotate({
    description:
      "Files to attach: a chat attachment number, artifact_ref, or allowed local path. Use chat_files_list to find reusable file references. Up to 25 MiB total."
  })
)

export const OmitAttachmentsSchema = Schema.optionalKey(
  Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 499 })))
    .check(Schema.isMaxLength(500))
    .annotate({
      description:
        "Attachment indices to omit, counting from zero. Omit this field to keep every attachment."
    })
)

type MailFileRequest = {
  readonly omit?: ReadonlyArray<number> | undefined
  readonly services: SharedFileAccess
  readonly ctx: ToolContext<ServerRunContext>
  readonly refs: ReadonlyArray<FileRef>
  readonly key: string
  readonly intent: JsonObject
}

export const gmailFilesCard = async ({
  services,
  ctx,
  refs,
  key,
  intent
}: MailFileRequest): Promise<{
  readonly attachments: NonNullable<ApprovalPresentation["attachments"]>
  readonly data: JsonObject
}> => {
  const files =
    refs.length === 0
      ? []
      : await services.prepare({ ctx, refs, key, maxBytes: MAX_EMAIL_ATTACHMENT_BYTES })
  return {
    attachments: files.map((file, index) => ({
      kind: "file" as const,
      index,
      name: file.name,
      media_type: file.media_type,
      size: file.size
    })),
    data: { shared_files: preparedFilesApproval({ key, refs, files, intent }) }
  }
}

export const gmailFilesForExecution = async ({
  services,
  ctx,
  refs,
  key,
  intent,
  omit = []
}: MailFileRequest): Promise<ReadonlyArray<MessageAttachment>> => {
  if (refs.length === 0 && ctx.approval === undefined && omit.length === 0) return []
  const files = await services.forExecution({
    ctx,
    refs,
    key,
    intent,
    maxBytes: MAX_EMAIL_ATTACHMENT_BYTES
  })
  if (omit.some((index) => !Number.isInteger(index) || index < 0 || index >= files.length))
    throw toolRefusal("An omitted attachment is not on this email.", "Invalid attachment selection")
  return files.filter((_, index) => !omit.includes(index))
}
