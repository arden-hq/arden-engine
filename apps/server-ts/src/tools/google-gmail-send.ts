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
import type { GoogleToolConnections } from "./google-accounts.js"
import { requiredAccountRefDescription } from "./google-accounts.js"
import {
  bodyProblem,
  REPLY_APPROVAL_EDITS,
  REPLY_EDITABLE_FIELDS,
  SEND_APPROVAL_EDITS,
  SEND_EDITABLE_FIELDS
} from "./google-gmail-edits.js"
import { gmailSend } from "./google-gmail-request.js"
import {
  GMAIL_API,
  header,
  mailboxAddresses,
  MAX_BODY_CHARS,
  message,
  normalizeMessageId,
  normalizeReferences,
  rawMessage,
  uniqueAddresses,
  validRecipient
} from "./google-gmail-mime.js"
import { messageRef, parseMessageRef, threadRef } from "./google-gmail-refs.js"
import { googleCall } from "./google-request.js"
import { sha256Base64Url } from "@arden-hq/std/hash"
import { toolRefusal } from "./tool-failure.js"

const MAX_RECIPIENTS = 50
const APPROVAL_RECIPIENT_FIELD_CHARS = 4_000

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
const ReplyParametersSchema = Schema.Struct({
  message_ref: Schema.String.annotate({
    description:
      "Exact account-qualified message_ref returned by email_search or email_thread_read."
  }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024)),
  body: Schema.String.annotate({
    description: "Plain-text reply body, from 1 to 200,000 characters."
  }).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BODY_CHARS)),
  attachments: EmailAttachmentsSchema,
  omit_attachments: OmitAttachmentsSchema,
  reply_all: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))).pipe(
    Schema.annotateEncoded({
      description:
        "When true, also include the original To and Cc recipients, excluding the connected account and duplicates. Defaults to false."
    })
  )
})
export const recipientPresentationFields = (
  label: "To" | "Cc",
  recipients: ReadonlyArray<string>
): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  const chunks: string[] = []
  let current = ""
  for (const recipient of recipients) {
    const candidate = current === "" ? recipient : `${current}, ${recipient}`
    if (candidate.length <= APPROVAL_RECIPIENT_FIELD_CHARS) {
      current = candidate
      continue
    }
    if (current !== "") chunks.push(current)
    current = recipient
  }
  if (current !== "") chunks.push(current)
  return chunks.map((value, index) => ({
    label: index === 0 ? label : `${label} ${index + 1}`,
    value
  }))
}

interface ReplyEnvelope {
  readonly account: string
  readonly originalThreadId: string
  readonly to: ReadonlyArray<string>
  readonly cc: ReadonlyArray<string>
  readonly subject: string
  readonly inReplyTo?: string
  readonly references?: string
}

interface SendEnvelope {
  readonly account: string
  readonly to: ReadonlyArray<string>
  readonly cc: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  readonly html: boolean
}

/** Gmail would send a blank email for a body of only whitespace. */
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

export const prepareReply = async (
  google: GoogleToolConnections,
  messageReference: string,
  replyAll: boolean,
  signal: AbortSignal
): Promise<ReplyEnvelope> => {
  const ref = parseMessageRef(messageReference)
  const sourceUrl = new URL(`${GMAIL_API}/messages/${encodeURIComponent(ref.id)}`)
  sourceUrl.searchParams.set("format", "metadata")
  for (const name of ["Reply-To", "From", "To", "Cc", "Subject", "Message-ID", "References"]) {
    sourceUrl.searchParams.append("metadataHeaders", name)
  }
  const sourceResponse = await googleCall({
    google,
    service: "gmail",
    url: sourceUrl.href,
    accountRef: ref.account,
    signal
  })
  const original = message(sourceResponse.value)
  if (original.id !== ref.id) {
    throw toolRefusal("Gmail returned a different message.", "Invalid Gmail response")
  }

  const from = mailboxAddresses(header(original.payload, "From"))
  const replyTo = mailboxAddresses(header(original.payload, "Reply-To"))
  const originalTo = mailboxAddresses(header(original.payload, "To"))
  const originalCc = mailboxAddresses(header(original.payload, "Cc"))
  if (
    from === undefined ||
    replyTo === undefined ||
    originalTo === undefined ||
    originalCc === undefined
  ) {
    throw toolRefusal(
      "The original email has a recipient header Arden cannot safely reconstruct.",
      "Cannot safely reply"
    )
  }

  const own = sourceResponse.account.email.toLowerCase()
  const replyCandidates = uniqueAddresses(replyTo.length > 0 ? replyTo : from, new Set([own]))
  const fallbackCandidates = uniqueAddresses(originalTo, new Set([own]))
  const to = replyCandidates.length > 0 ? replyCandidates : fallbackCandidates
  if (to.length === 0) {
    throw toolRefusal("The original email has no valid reply address.", "Cannot reply")
  }
  const cc = replyAll
    ? uniqueAddresses(
        [...originalTo, ...originalCc],
        new Set([own, ...to.map((recipient) => recipient.toLowerCase())])
      )
    : []
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw toolRefusal("This reply has too many recipients.", "Too many recipients")
  }

  const subject = header(original.payload, "Subject") ?? ""
  const rawMessageId = header(original.payload, "Message-ID")
  const originalMessageId =
    rawMessageId === undefined ? undefined : normalizeMessageId(rawMessageId)
  const rawReferences = header(original.payload, "References")
  const previousReferences =
    rawReferences === undefined ? undefined : normalizeReferences(rawReferences)
  if (
    (rawMessageId !== undefined && originalMessageId === null) ||
    (rawReferences !== undefined && previousReferences === null)
  ) {
    throw toolRefusal(
      "The original email has malformed reply headers Arden cannot safely preserve.",
      "Cannot safely reply"
    )
  }
  const references = [previousReferences, originalMessageId].filter(Boolean).join(" ") || undefined
  return {
    account: sourceResponse.account.email,
    originalThreadId: original.threadId,
    to,
    cc,
    subject: /^re:/iu.test(subject) ? subject : `Re: ${subject}`,
    ...(originalMessageId === undefined || originalMessageId === null
      ? {}
      : { inReplyTo: originalMessageId }),
    ...(references === undefined ? {} : { references })
  }
}

const approvalReplyData = (
  input: { readonly message_ref: string; readonly reply_all: boolean },
  envelope: ReplyEnvelope
) => ({
  kind: "gmail_reply_v1",
  message_ref: input.message_ref,
  reply_all: input.reply_all,
  account: envelope.account,
  original_thread_id: envelope.originalThreadId,
  to: [...envelope.to],
  cc: [...envelope.cc],
  subject: envelope.subject,
  ...(envelope.inReplyTo === undefined ? {} : { in_reply_to: envelope.inReplyTo }),
  ...(envelope.references === undefined ? {} : { references: envelope.references })
})

const approvedReplyEnvelope = (
  input: { readonly message_ref: string; readonly reply_all: boolean },
  data: Readonly<Record<string, unknown>> | undefined
): ReplyEnvelope => {
  const stringArray = (value: unknown): ReadonlyArray<string> | undefined =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && validRecipient(item))
      ? value
      : undefined
  const to = stringArray(data?.to)
  const cc = stringArray(data?.cc)
  const inReplyTo =
    typeof data?.in_reply_to === "string" ? normalizeMessageId(data.in_reply_to) : undefined
  const references =
    typeof data?.references === "string" ? normalizeReferences(data.references) : undefined
  if (
    data?.kind !== "gmail_reply_v1" ||
    data.message_ref !== input.message_ref ||
    data.reply_all !== input.reply_all ||
    typeof data.account !== "string" ||
    !validRecipient(data.account) ||
    typeof data.original_thread_id !== "string" ||
    data.original_thread_id === "" ||
    to === undefined ||
    to.length === 0 ||
    cc === undefined ||
    to.length + cc.length > MAX_RECIPIENTS ||
    typeof data.subject !== "string" ||
    (data.in_reply_to !== undefined && inReplyTo === null) ||
    (data.references !== undefined && references === null)
  ) {
    throw toolRefusal(
      "The approved Gmail recipient envelope is missing or no longer matches this call.",
      "Approval mismatch"
    )
  }
  return {
    account: data.account,
    originalThreadId: data.original_thread_id,
    to,
    cc,
    subject: data.subject,
    ...(inReplyTo === undefined || inReplyTo === null ? {} : { inReplyTo }),
    ...(references === undefined || references === null || references === "" ? {} : { references })
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
      description: [
        "Send a new plain-text or HTML email from an explicit connected Gmail account.",
        "Use email_reply for an existing conversation."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(SendParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Send Email",
        kind: "tool",
        action: "write",
        approval_preview: "Send this email.",
        display: { mail: "send" },
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
            ...(envelope.html
              ? {}
              : { editable: { fields: SEND_EDITABLE_FIELDS, arguments: jsonArguments(input) } })
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
        display: { mail: "reply" },
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
            editable: { fields: REPLY_EDITABLE_FIELDS, arguments: jsonArguments(input) }
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
