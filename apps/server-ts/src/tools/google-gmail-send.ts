import { countOf } from "@arden-hq/std/count"
import type { ToolResultOutput } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import type { CallEffects } from "../execution/tool-effect.js"
import type { DraftMessage } from "./google-gmail-draft.js"
import {
  EmailAttachmentsSchema,
  OmitAttachmentsSchema,
  gmailFilesCard,
  gmailFilesForExecution
} from "./google-gmail-files.js"
import type { SharedFileAccess } from "./shared-files.js"

import { defineServerTool, type ServerTool } from "./define.js"
import { jsonArguments } from "./automation-create-card.js"
import { requiredAccountRefDescription, type GoogleToolConnections } from "./google-accounts.js"
import {
  bodyProblem,
  REPLY_APPROVAL_EDITS,
  replyEditable,
  SEND_APPROVAL_EDITS,
  sendEditable
} from "./google-gmail-edits.js"
import { gmailSend } from "./google-gmail-request.js"
import { MAX_BODY_CHARS, rawMessage, uniqueAddresses, validRecipient } from "./google-gmail-mime.js"
import { messageRef, threadRef } from "./google-gmail-refs.js"
import { sha256Base64Url } from "@arden-hq/std/hash"
import { toolRefusal } from "./tool-failure.js"
import { MAX_RECIPIENTS, recipientPresentationFields } from "./google-gmail-recipients.js"
import {
  ReplyParametersSchema,
  approvalReplyData,
  approvedReplyEnvelope,
  prepareReply
} from "./google-gmail-reply.js"

const sendParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    account_ref: Schema.String.annotate({
      description: requiredAccountRefDescription(
        "gmail",
        "Exact email address of the connected Gmail account that will send the message.",
        emails
      )
    }).check(Schema.isMinLength(1), Schema.isMaxLength(320)),
    recipient: Schema.String.annotate({
      description: "Single To email address. Put additional recipients in cc."
    }).check(Schema.isMinLength(3), Schema.isMaxLength(320)),
    cc: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)))
        .annotate({
          description:
            "Additional Cc email addresses. Duplicates are removed; To plus Cc may contain at most 50 recipients."
        })
        .check(Schema.isMaxLength(MAX_RECIPIENTS))
    ),
    subject: Schema.String.annotate({
      description: "Subject line, up to 998 characters. May be empty; line breaks are rejected."
    }).check(Schema.isMaxLength(998)),
    body: Schema.String.annotate({
      description: "Message body, from 1 to 200,000 characters. Plain text unless html is true."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BODY_CHARS)),
    attachments: EmailAttachmentsSchema,
    omit_attachments: OmitAttachmentsSchema,
    html: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))).pipe(
      Schema.annotateEncoded({
        description: "Send body as text/html when true or text/plain when false. Defaults to false."
      })
    )
  })
interface SendEnvelope {
  readonly account: string
  readonly to: ReadonlyArray<string>
  readonly cc: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  readonly html: boolean
}

const requireBody = (body: string): void => {
  const problem = bodyProblem({ body })
  if (problem !== undefined) throw toolRefusal(problem, "Empty email body")
}

const prepareSend = (input: {
  readonly account_ref: string
  readonly recipient: string
  readonly cc?: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  readonly html: boolean
}): SendEnvelope => {
  if (!validRecipient(input.recipient)) {
    throw toolRefusal("A valid recipient email address is required.", "Invalid recipient")
  }
  if ((input.cc ?? []).some((recipient) => !validRecipient(recipient))) {
    throw toolRefusal("Every Cc value must be a valid email address.", "Invalid Cc recipient")
  }
  if (!validRecipient(input.account_ref)) {
    throw toolRefusal("Use the exact connected Gmail account email.", "Invalid Gmail account")
  }
  if (/[\r\n]/u.test(input.subject)) {
    throw toolRefusal("Email subjects cannot contain line breaks.", "Invalid email subject")
  }
  requireBody(input.body)
  const cc = uniqueAddresses(input.cc ?? [], new Set([input.recipient.toLowerCase()]))
  if (1 + cc.length > MAX_RECIPIENTS) {
    throw toolRefusal("This email has too many recipients.", "Too many recipients")
  }
  return {
    account: input.account_ref,
    to: [input.recipient],
    cc,
    subject: input.subject,
    body: input.body,
    html: input.html
  }
}

export type SaveCardDraft = (request: {
  readonly draft: DraftMessage
  readonly toolName: string
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly effects: CallEffects
}) => Promise<ToolResultOutput>

export const localMessageId = (seed: string): string =>
  `arden-${sha256Base64Url(seed).slice(0, 32)}@local.arden`

export const gmailSendTools = ({
  google,
  emails,
  saveDraft,
  files
}: {
  readonly google: GoogleToolConnections
  readonly emails: ReadonlyArray<string>
  readonly files: SharedFileAccess
  readonly saveDraft: SaveCardDraft
}): ReadonlyArray<ServerTool> => {
  const SendParametersSchema = sendParametersSchema(emails)
  return [
    defineServerTool({
      name: "email_send",
      summary: "Sends an email.",
      discovery: { group: "email" },
      description: [
        "Send a new plain-text or HTML email from an explicit connected Gmail account.",
        "The user cannot edit an HTML email or save it as a draft from the approval card.",
        "Use email_reply for an existing conversation."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(SendParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Send Email",
        kind: "tool",
        action: "write",
        approval_preview: "Send this email.",
        display: [{ fact: "mail", value: "send" }],
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
        const envelope = prepareSend(input)
        const attachments = await gmailFilesCard({
          services: files,
          ctx,
          refs: input.attachments ?? [],
          key: `email_send:${ctx.toolCallId}`,
          intent: jsonArguments({
            account: envelope.account,
            to: envelope.to,
            cc: envelope.cc,
            html: envelope.html
          })
        })
        return {
          preview: `Send email to ${envelope.to[0]}`,
          presentation: {
            title: "Send this email?",
            approve_label: "Send",
            fields: [
              { label: "From", value: envelope.account },
              ...recipientPresentationFields("To", envelope.to),
              ...recipientPresentationFields("Cc", envelope.cc),
              { label: "Subject", value: envelope.subject || "(no subject)" }
            ],
            attachments: attachments.attachments,
            body: { label: envelope.html ? "HTML body" : "Message", text: envelope.body },
            ...(envelope.html ? {} : { editable: sendEditable(input, envelope.account) })
          },
          data: attachments.data
        }
      },
      approvalEdits: SEND_APPROVAL_EDITS,
      approvalDraft: async (input, ctx, effects) => {
        const envelope = prepareSend(input)
        if (envelope.html) {
          throw toolRefusal("An HTML email cannot be saved as a draft here.", "No draft")
        }
        const attachments = await gmailFilesForExecution({
          omit: input.omit_attachments,
          services: files,
          ctx,
          refs: input.attachments ?? [],
          key: `email_send:${ctx.toolCallId}`,
          intent: jsonArguments({
            account: envelope.account,
            to: envelope.to,
            cc: envelope.cc,
            html: envelope.html
          })
        })
        return saveDraft({
          draft: {
            attachments,
            account: envelope.account,
            to: envelope.to,
            cc: envelope.cc,
            subject: envelope.subject,
            body: envelope.body
          },
          toolName: "email_send",
          toolCallId: ctx.toolCallId,
          signal: ctx.signal,
          effects
        })
      },
      execute: async (input, ctx, effects) => {
        const envelope = prepareSend(input)
        const attachments = await gmailFilesForExecution({
          omit: input.omit_attachments,
          services: files,
          ctx,
          refs: input.attachments ?? [],
          key: `email_send:${ctx.toolCallId}`,
          intent: jsonArguments({
            account: envelope.account,
            to: envelope.to,
            cc: envelope.cc,
            html: envelope.html
          })
        })
        const raw = rawMessage({
          attachments,
          sender: envelope.account,
          to: envelope.to,
          cc: envelope.cc,
          subject: envelope.subject,
          body: envelope.body,
          html: envelope.html,
          messageId: localMessageId(ctx.toolCallId)
        })
        const sent = await gmailSend({
          google,
          account: envelope.account,
          subject: envelope.subject,
          body: { raw },
          signal: ctx.signal,
          effects
        })
        return {
          result: `Email sent to ${envelope.to[0]}.`,
          preview: `Sent to ${envelope.to[0]}`,
          data: {
            account_ref: envelope.account,
            recipient: envelope.to[0],
            cc: envelope.cc,
            message_ref: messageRef(envelope.account, sent.id),
            thread_ref: threadRef(envelope.account, sent.threadId),
            gmail_send_receipt: {
              kind: "gmail_send_v1",
              provider_message_id: sent.id,
              provider_thread_id: sent.threadId,
              recipient: envelope.to[0],
              confirmed_at: sent.confirmedAt
            }
          }
        }
      }
    }),
    defineServerTool({
      name: "email_reply",
      summary: "Replies to an email.",
      discovery: { group: "email" },
      description: [
        "Send a plain-text reply in the source message's existing Gmail thread, with optional reply-all recipient reconstruction.",
        "Use email_send for a new conversation."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(ReplyParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Reply to Email",
        kind: "tool",
        action: "write",
        approval_preview: "Send this Gmail reply.",
        display: [{ fact: "mail", value: "reply" }],
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
        requireBody(input.body)
        const envelope = await prepareReply(google, input.message_ref, input.reply_all, ctx.signal)
        const attachments = await gmailFilesCard({
          services: files,
          ctx,
          refs: input.attachments ?? [],
          key: `email_reply:${ctx.toolCallId}`,
          intent: jsonArguments(approvalReplyData(input, envelope))
        })
        return {
          preview: input.reply_all ? "Reply to everyone" : `Reply to ${envelope.to[0]}`,
          presentation: {
            title: input.reply_all ? "Reply to everyone?" : "Send this reply?",
            approve_label: "Send",
            fields: [
              { label: "From", value: envelope.account },
              ...recipientPresentationFields("To", envelope.to),
              ...recipientPresentationFields("Cc", envelope.cc),
              { label: "Subject", value: envelope.subject || "(no subject)" }
            ],
            attachments: attachments.attachments,
            body: { label: "Message", text: input.body },
            editable: replyEditable(input, envelope.account)
          },
          data: { ...approvalReplyData(input, envelope), ...attachments.data }
        }
      },
      approvalEdits: REPLY_APPROVAL_EDITS,
      approvalDraft: async (input, ctx, effects) => {
        const envelope =
          ctx.approval === undefined
            ? await prepareReply(google, input.message_ref, input.reply_all, ctx.signal)
            : approvedReplyEnvelope(input, ctx.approval.data)
        const attachments = await gmailFilesForExecution({
          omit: input.omit_attachments,
          services: files,
          ctx,
          refs: input.attachments ?? [],
          key: `email_reply:${ctx.toolCallId}`,
          intent: jsonArguments(approvalReplyData(input, envelope))
        })
        return saveDraft({
          draft: {
            attachments,
            account: envelope.account,
            to: envelope.to,
            cc: envelope.cc,
            subject: envelope.subject,
            body: input.body,
            thread: {
              id: envelope.originalThreadId,
              ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
              ...(envelope.references === undefined ? {} : { references: envelope.references })
            }
          },
          toolName: "email_reply",
          toolCallId: ctx.toolCallId,
          signal: ctx.signal,
          effects
        })
      },
      execute: async (input, ctx, effects) => {
        requireBody(input.body)
        const envelope =
          ctx.approval === undefined
            ? await prepareReply(google, input.message_ref, input.reply_all, ctx.signal)
            : approvedReplyEnvelope(input, ctx.approval.data)
        const attachments = await gmailFilesForExecution({
          omit: input.omit_attachments,
          services: files,
          ctx,
          refs: input.attachments ?? [],
          key: `email_reply:${ctx.toolCallId}`,
          intent: jsonArguments(approvalReplyData(input, envelope))
        })
        const raw = rawMessage({
          attachments,
          sender: envelope.account,
          to: envelope.to,
          cc: envelope.cc,
          subject: envelope.subject,
          body: input.body,
          html: false,
          messageId: localMessageId(ctx.toolCallId),
          ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
          ...(envelope.references === undefined ? {} : { references: envelope.references })
        })
        const sent = await gmailSend({
          google,
          account: envelope.account,
          subject: envelope.subject,
          body: { raw, threadId: envelope.originalThreadId },
          signal: ctx.signal,
          effects
        })
        const recipients = envelope.to.join(", ")
        return {
          result:
            envelope.cc.length === 0
              ? `Reply sent to ${recipients}.`
              : `Reply sent to ${recipients}, with Cc to ${envelope.cc.join(", ")}.`,
          preview: `Replied to ${countOf(envelope.to.length + envelope.cc.length, "recipient")}`,
          data: {
            account_ref: envelope.account,
            recipient: envelope.to[0],
            recipients: envelope.to,
            cc: envelope.cc,
            reply_all: input.reply_all,
            message_ref: messageRef(envelope.account, sent.id),
            thread_ref: threadRef(envelope.account, sent.threadId),
            gmail_send_receipt: {
              kind: "gmail_send_v1",
              provider_message_id: sent.id,
              provider_thread_id: sent.threadId,
              recipient: envelope.to[0],
              confirmed_at: sent.confirmedAt
            }
          }
        }
      }
    })
  ]
}
