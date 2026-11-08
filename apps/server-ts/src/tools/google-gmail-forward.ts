import { countOf, formatBytes } from "@arden-hq/std/count"
import { Option, Schema } from "effect"
import type { ToolContext } from "@arden-hq/loop"
import type { ServerRunContext } from "./run-context.js"
import { FileRefSchema, type FileRef, type SharedFileAccess } from "./shared-files.js"
import {
  gmailFilesCard,
  gmailFilesForExecution,
  OmitAttachmentsSchema
} from "./google-gmail-files.js"

import { jsonArguments } from "./automation-create-card.js"
import { mailEditLines } from "./google-gmail-edits.js"
import type { ApprovalEditLine, ServerApprovalEdits } from "./approval-edits.js"
import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { requiredAccountRefDescription } from "./google-accounts.js"
import { attachmentBytes, readFullMessage } from "./google-gmail-attachment.js"
import {
  attachmentParts,
  header,
  MAX_BODY_CHARS,
  MAX_EMAIL_ATTACHMENT_BYTES,
  payloadText,
  rawForward,
  uniqueAddresses,
  validRecipient
} from "./google-gmail-mime.js"
import { messageRef, threadRef } from "./google-gmail-refs.js"
import { gmailSend } from "./google-gmail-request.js"
import { localMessageId, recipientPresentationFields } from "./google-gmail-send.js"
import { toolRefusal } from "./tool-failure.js"
import { safeAttachmentName } from "./shared-file-sources.js"

const MAX_RECIPIENTS = 50
const MAX_FORWARD_BYTES = MAX_EMAIL_ATTACHMENT_BYTES
const EMPTY_NOTE = "(No note. The original message is forwarded below.)"

interface ForwardInput {
  readonly message_ref: string
  readonly to: ReadonlyArray<string>
  readonly cc?: ReadonlyArray<string>
  readonly omit_attachments?: ReadonlyArray<number>
  readonly note?: string
}

const FORWARD_APPROVAL_EDITS: ServerApprovalEdits<Pick<ForwardInput, "note" | "omit_attachments">> =
  {
    fields: ["note", "omit_attachments"],
    describe: (requested, edited): ReadonlyArray<ApprovalEditLine> =>
      mailEditLines(
        { ...requested, body: requested.note ?? "" },
        { ...edited, body: edited.note ?? "" }
      ).map((line) => (line.field === "body" ? { ...line, field: "note", label: "Note" } : line))
  }

const recipients = (
  input: ForwardInput
): { readonly to: ReadonlyArray<string>; readonly cc: ReadonlyArray<string> } => {
  if ([...input.to, ...(input.cc ?? [])].some((address) => !validRecipient(address))) {
    throw toolRefusal("Every To and Cc value must be a valid email address.", "Invalid recipient")
  }
  const to = uniqueAddresses(input.to, new Set())
  const cc = uniqueAddresses(input.cc ?? [], new Set(to.map((address) => address.toLowerCase())))
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw toolRefusal("This email has too many recipients.", "Too many recipients")
  }
  return { to, cc }
}

const tooLarge = () =>
  toolRefusal(
    `The attachments are larger than ${formatBytes(MAX_FORWARD_BYTES)}, too much for one forward.`,
    "Attachments too large"
  )

const forwardSubject = (subject: string): string =>
  /^fwd?:/iu.test(subject) ? subject : `Fwd: ${subject}`

const forwardParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    message_ref: Schema.String.annotate({
      description: requiredAccountRefDescription(
        "gmail",
        "Exact account-qualified message_ref returned by email_search or email_thread_read. The forward is sent from this message's account.",
        emails
      )
    }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024)),
    to: Schema.Array(Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)))
      .annotate({ description: "To email addresses of the people the message goes to." })
      .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RECIPIENTS)),
    cc: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)))
        .annotate({ description: "Cc email addresses. To plus Cc may contain at most 50 people." })
        .check(Schema.isMaxLength(MAX_RECIPIENTS))
    ),
    omit_attachments: OmitAttachmentsSchema,
    note: Schema.optionalKey(
      Schema.String.annotate({
        description: "Optional plain-text note above the forwarded message."
      }).check(Schema.isMaxLength(MAX_BODY_CHARS))
    )
  })

export const gmailForwardTool = ({
  google,
  emails,
  files
}: {
  readonly google: GoogleToolConnections
  readonly emails: ReadonlyArray<string>
  readonly files: SharedFileAccess
}): ServerTool => {
  const freezeOriginal = async (input: ForwardInput, ctx: ToolContext<ServerRunContext>) => {
    const read = await readFullMessage({
      google,
      messageReference: input.message_ref,
      signal: ctx.signal
    })
    const payload = read.message.payload
    const parts = attachmentParts(payload)
    if (parts.reduce((size, part) => size + (part.size ?? 0), 0) > MAX_FORWARD_BYTES)
      throw tooLarge()
    const refs: Array<FileRef> = []
    let downloaded = 0
    for (const part of parts) {
      const bytes = await attachmentBytes({
        google,
        account: read.account,
        messageId: read.id,
        part,
        signal: ctx.signal
      })
      downloaded += bytes.byteLength
      if (downloaded > MAX_FORWARD_BYTES) throw tooLarge()
      const saved = await files.publish({
        ctx,
        key: `email_forward:${ctx.toolCallId}:${part.index}`,
        name: safeAttachmentName(part.filename, `attachment-${part.index}`),
        bytes,
        mediaType: part.mimeType
      })
      if (saved.kind !== "snapshot")
        throw toolRefusal(
          "The forwarded attachment could not be saved safely.",
          "Attachment unavailable"
        )
      refs.push({ artifact_ref: saved.artifact_ref })
    }
    return {
      original: {
        account: read.account,
        id: read.id,
        subject: header(payload, "Subject") ?? "",
        from: header(payload, "From") ?? "",
        to: header(payload, "To") ?? "",
        date: header(payload, "Date") ?? "",
        text: payloadText(payload).text
      },
      refs
    }
  }
  return defineServerTool({
    name: "email_forward",
    description: [
      "Forward one Gmail message, with its attachments, to new recipients and an optional note.",
      "Use email_reply to answer the sender."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(forwardParametersSchema(emails)),
    metadata: {
      effect: "external",
      display_name: "Forward Email",
      kind: "tool",
      action: "write",
      approval_preview: "Forward this email.",
      display: { mail: "forward" },
      source: "gmail",
      changes_state: true,
      concurrency_group: "gmail_write",
      destructive: false,
      default_approval: "ask",
      policy_scope: "external",
      permissions: ["email"],
      idempotent: false,
      target: "reported"
    },
    approvalPrompt: async (input, ctx) => {
      const { to, cc } = recipients(input)
      const frozen = await freezeOriginal(input, ctx)
      const { original, refs } = frozen
      const attachments = await gmailFilesCard({
        services: files,
        ctx,
        refs,
        key: `email_forward:${ctx.toolCallId}`,
        intent: jsonArguments({
          message_ref: input.message_ref,
          account: original.account,
          to,
          cc,
          subject: forwardSubject(original.subject)
        })
      })
      return {
        preview: `Forward email to ${to[0]}`,
        presentation: {
          title: "Forward this email?",
          approve_label: "Forward",
          fields: [
            { label: "From", value: original.account },
            ...recipientPresentationFields("To", to),
            ...recipientPresentationFields("Cc", cc),
            { label: "Subject", value: forwardSubject(original.subject) || "(no subject)" }
          ],
          attachments: attachments.attachments,
          body: { label: "Message", text: input.note?.trim() ? input.note : EMPTY_NOTE },
          editable: { fields: ["note", "omit_attachments"], arguments: jsonArguments(input) }
        },
        data: { forward_original: original, forward_refs: refs, ...attachments.data }
      }
    },
    approvalEdits: FORWARD_APPROVAL_EDITS,
    execute: async (input, ctx, effects) => {
      const { to, cc } = recipients(input)
      const frozen =
        ctx.approval === undefined
          ? await freezeOriginal(input, ctx)
          : approvedOriginal(ctx.approval.data)
      const { original, refs } = frozen
      const attachments = await gmailFilesForExecution({
        omit: input.omit_attachments,
        services: files,
        ctx,
        refs,
        key: `email_forward:${ctx.toolCallId}`,
        intent: jsonArguments({
          message_ref: input.message_ref,
          account: original.account,
          to,
          cc,
          subject: forwardSubject(original.subject)
        })
      })
      const subject = forwardSubject(original.subject)
      const raw = rawForward({
        sender: original.account,
        to,
        cc,
        subject,
        note: input.note ?? "",
        original,
        attachments,
        messageId: localMessageId(ctx.toolCallId)
      })
      const sent = await gmailSend({
        google,
        account: original.account,
        subject,
        body: { raw },
        signal: ctx.signal,
        effects
      })
      return {
        result: `Forwarded to ${to.join(", ")}${attachments.length === 0 ? "" : ` with ${countOf(attachments.length, "attachment")}`}.`,
        preview: `Forwarded to ${to[0]}`,
        data: {
          account_ref: original.account,
          recipient: to[0],
          recipients: to,
          cc,
          message_ref: messageRef(original.account, sent.id),
          thread_ref: threadRef(original.account, sent.threadId),
          gmail_send_receipt: {
            kind: "gmail_send_v1",
            provider_message_id: sent.id,
            provider_thread_id: sent.threadId,
            recipient: to[0],
            confirmed_at: sent.confirmedAt
          }
        }
      }
    }
  })
}

const ForwardOriginalSchema = Schema.Struct({
  forward_original: Schema.Struct({
    account: Schema.NonEmptyString,
    id: Schema.NonEmptyString,
    subject: Schema.String,
    from: Schema.String,
    to: Schema.String,
    date: Schema.String,
    text: Schema.String
  }),
  forward_refs: Schema.Array(FileRefSchema)
})
const approvedOriginal = (data: unknown) => {
  const approved = Option.getOrUndefined(Schema.decodeUnknownOption(ForwardOriginalSchema)(data))
  if (approved === undefined)
    throw toolRefusal(
      "The approved forward is missing its saved message and files. Nothing was sent. Ask again with the current email.",
      "Approval mismatch"
    )
  return { original: approved.forward_original, refs: approved.forward_refs }
}
