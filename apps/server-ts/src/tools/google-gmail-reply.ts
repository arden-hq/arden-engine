import { Effect, Schema } from "effect"

import { EmailAttachmentsSchema, OmitAttachmentsSchema } from "./google-gmail-files.js"

import type { GoogleToolConnections } from "./google-accounts.js"
import {
  GMAIL_API,
  header,
  mailboxAddresses,
  MAX_BODY_CHARS,
  message,
  normalizeMessageId,
  normalizeReferences,
  uniqueAddresses,
  validRecipient
} from "./google-gmail-mime.js"
import { parseMessageRef } from "./google-gmail-refs.js"
import { googleCall } from "./google-request.js"
import { toolRefusal } from "./tool-failure.js"
import { MAX_RECIPIENTS } from "./google-gmail-recipients.js"

const GMAIL_REPLY_CARD = "gmail_reply_v1"

export const ReplyParametersSchema = Schema.Struct({
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

export interface ReplyEnvelope {
  readonly account: string
  readonly originalThreadId: string
  readonly to: ReadonlyArray<string>
  readonly cc: ReadonlyArray<string>
  readonly subject: string
  readonly inReplyTo?: string
  readonly references?: string
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

export type ApprovalReplyData = {
  readonly references?: string
  readonly in_reply_to?: string
  readonly kind: string
  readonly message_ref: string
  readonly reply_all: boolean
  readonly account: string
  readonly original_thread_id: string
  readonly to: Array<string>
  readonly cc: Array<string>
  readonly subject: string
}

export const approvalReplyData = (
  input: { readonly message_ref: string; readonly reply_all: boolean },
  envelope: ReplyEnvelope
): ApprovalReplyData => ({
  kind: GMAIL_REPLY_CARD,
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

export const approvedReplyEnvelope = (
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
    data?.kind !== GMAIL_REPLY_CARD ||
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
