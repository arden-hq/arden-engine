import { gmailViewUrl, type GoogleAccount } from "@arden-hq/protocol/google"
import type { ToolResultOutput, ToolContext } from "@arden-hq/loop"
import { Option, Schema } from "effect"
import { jsonArguments } from "./automation-create-card.js"
import {
  EmailAttachmentsSchema,
  gmailFilesCard,
  gmailFilesForExecution
} from "./google-gmail-files.js"
import type { FileRef, SharedFileAccess } from "./shared-files.js"
import type { MessageAttachment } from "./google-gmail-mime.js"
import type { ServerRunContext } from "./run-context.js"

import type { CallEffects } from "../execution/tool-effect.js"
import type { ServerTool, ServerApprovalPrompt } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { requiredAccountRefDescription, googleServiceAccount } from "./google-accounts.js"
import {
  GMAIL_API,
  MAX_BODY_CHARS,
  rawMessage,
  uniqueAddresses,
  validRecipient
} from "./google-gmail-mime.js"
import {
  defineGoogleTool,
  requireGoogleGrant,
  type GoogleGrantDescription
} from "./google-tool-grant.js"
import { parseMessageRef, threadRef } from "./google-gmail-refs.js"
import { localMessageId, prepareReply, recipientPresentationFields } from "./google-gmail-send.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { toolRefusal } from "./tool-failure.js"

const MAX_RECIPIENTS = 50

interface GmailDraftRequest {
  readonly account_ref?: string
  readonly to?: ReadonlyArray<string>
  readonly cc?: ReadonlyArray<string>
  readonly subject?: string
  readonly body: string
  readonly reply_to_message_ref?: string
  readonly reply_all?: boolean
  readonly attachments?: ReadonlyArray<FileRef>
}

export interface DraftMessage {
  readonly account: string
  readonly to: ReadonlyArray<string>
  readonly cc: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  readonly attachments?: ReadonlyArray<MessageAttachment>
  readonly thread?: {
    readonly id: string
    readonly inReplyTo?: string
    readonly references?: string
  }
}

const draftRequestBody = (
  draft: DraftMessage,
  messageId: string
): { readonly message: { readonly raw: string; readonly threadId?: string } } => ({
  message: {
    raw: rawMessage({
      sender: draft.account,
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      body: draft.body,
      html: false,
      messageId,
      attachments: draft.attachments ?? [],
      ...(draft.thread?.inReplyTo === undefined ? {} : { inReplyTo: draft.thread.inReplyTo }),
      ...(draft.thread?.references === undefined ? {} : { references: draft.thread.references })
    }),
    ...(draft.thread === undefined ? {} : { threadId: draft.thread.id })
  }
})

const DRAFT_GRANT = {
  grant: "gmail_drafts",
  what: "save Gmail drafts",
  note: "Approving asks Google to let Arden save drafts."
} as const satisfies GoogleGrantDescription

const checkAddresses = (addresses: ReadonlyArray<string>, label: string): void => {
  if (addresses.some((address) => !validRecipient(address))) {
    throw toolRefusal(`Every ${label} value must be a valid email address.`, `Invalid ${label}`)
  }
}

const draftAccountRef = (request: GmailDraftRequest): string => {
  if (request.reply_to_message_ref !== undefined) {
    const account = parseMessageRef(request.reply_to_message_ref).account
    if (
      request.account_ref !== undefined &&
      request.account_ref.toLowerCase() !== account.toLowerCase()
    ) {
      throw toolRefusal(
        "account_ref must be the account in reply_to_message_ref.",
        "Account mismatch"
      )
    }
    return account
  }
  if (request.account_ref === undefined) {
    throw toolRefusal("A new draft needs account_ref.", "Choose a Gmail account")
  }
  return request.account_ref
}

const prepareDraft = async (
  google: GoogleToolConnections,
  request: GmailDraftRequest,
  account: GoogleAccount,
  signal: AbortSignal
): Promise<DraftMessage> => {
  if (request.subject !== undefined && /[\r\n]/u.test(request.subject)) {
    throw toolRefusal("Email subjects cannot contain line breaks.", "Invalid email subject")
  }
  checkAddresses(request.to ?? [], "To")
  checkAddresses(request.cc ?? [], "Cc")
  const reply =
    request.reply_to_message_ref === undefined
      ? undefined
      : await prepareReply(google, request.reply_to_message_ref, request.reply_all ?? false, signal)
  const to = uniqueAddresses(request.to ?? reply?.to ?? [], new Set())
  if (to.length === 0) {
    throw toolRefusal("A new draft needs at least one To address.", "Invalid recipient")
  }
  const cc = uniqueAddresses(
    request.cc ?? reply?.cc ?? [],
    new Set(to.map((address) => address.toLowerCase()))
  )
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw toolRefusal("This draft has too many recipients.", "Too many recipients")
  }
  return {
    account: account.email,
    to,
    cc,
    subject: request.subject ?? reply?.subject ?? "",
    body: request.body,
    ...(reply === undefined
      ? {}
      : {
          thread: {
            id: reply.originalThreadId,
            ...(reply.inReplyTo === undefined ? {} : { inReplyTo: reply.inReplyTo }),
            ...(reply.references === undefined ? {} : { references: reply.references })
          }
        })
  }
}

interface SavedDraft {
  readonly account: string
  readonly draft_id: string
  readonly thread_ref: string
}

const decodeDraft = decodeGoogle(
  Schema.Struct({
    id: Schema.NonEmptyString,
    message: Schema.Struct({ id: Schema.NonEmptyString, threadId: Schema.NonEmptyString })
  }),
  { service: "gmail", label: "draft" }
)

const resolveDraft = async ({
  google,
  request,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly request: GmailDraftRequest
  readonly signal: AbortSignal
}): Promise<DraftMessage> => {
  const account = googleServiceAccount({
    accounts: google.accounts(),
    accountRef: draftAccountRef(request),
    service: "gmail"
  })
  if (account === undefined) {
    throw toolRefusal("Use the exact connected Gmail account email.", "Invalid Gmail account")
  }
  return prepareDraft(google, request, account, signal)
}

const createDraft = async ({
  google,
  draft,
  messageId,
  signal,
  effects
}: {
  readonly google: GoogleToolConnections
  readonly draft: DraftMessage
  readonly messageId: string
  readonly signal: AbortSignal
  readonly effects: CallEffects
}): Promise<SavedDraft> => {
  const response = await googleCall({
    google,
    service: "gmail",
    url: `${GMAIL_API}/drafts`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draftRequestBody(draft, messageId))
    },
    accountRef: draft.account,
    signal,
    effects
  })
  const saved = decodeDraft(response.value)
  await effects.created({
    source: "gmail_draft",
    objectId: saved.id,
    title: draft.subject || "(no subject)",
    href: gmailViewUrl(draft.account, "drafts")
  })
  return {
    account: draft.account,
    draft_id: saved.id,
    thread_ref: threadRef(draft.account, saved.message.threadId)
  }
}

export const saveCardDraft = async ({
  google,
  draft,
  toolName,
  toolCallId,
  signal,
  effects
}: {
  readonly google: GoogleToolConnections
  readonly draft: DraftMessage
  readonly toolName: string
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly effects: CallEffects
}): Promise<ToolResultOutput> => {
  requireGoogleGrant({ google, need: DRAFT_GRANT, target: { accountRef: draft.account } })
  const saved = await createDraft({
    google,
    draft,
    messageId: localMessageId(toolCallId),
    signal,
    effects
  })
  return {
    result: [
      `The user chose Save as draft on the approval card: the email was saved as a Gmail draft in ${saved.account} (draft id ${saved.draft_id}) and was not sent.`,
      `Do not send it and do not call ${toolName} for it again unless the user asks; it waits in their Drafts.`
    ].join(" "),
    preview: `Saved as a draft in ${saved.account}`,
    data: {
      account_ref: saved.account,
      thread_ref: saved.thread_ref,
      gmail_draft: {
        account: saved.account,
        draft_id: saved.draft_id,
        thread_ref: saved.thread_ref
      }
    }
  }
}

const draftParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    account_ref: Schema.optionalKey(
      Schema.String.annotate({
        description: requiredAccountRefDescription(
          "gmail",
          "Exact email address of the connected Gmail account that keeps the draft. Required for a new draft; a reply takes the account from reply_to_message_ref.",
          emails
        )
      }).check(Schema.isMinLength(1), Schema.isMaxLength(320))
    ),
    to: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)))
        .annotate({
          description:
            "To email addresses. Required for a new draft; a reply defaults to the people it answers."
        })
        .check(Schema.isMaxLength(MAX_RECIPIENTS))
    ),
    cc: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)))
        .annotate({
          description:
            "Cc email addresses. A reply-all defaults to the original To and Cc. To plus Cc may contain at most 50 recipients."
        })
        .check(Schema.isMaxLength(MAX_RECIPIENTS))
    ),
    subject: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Subject line, up to 998 characters, no line breaks. A reply defaults to Re: and the original subject."
      }).check(Schema.isMaxLength(998))
    ),
    body: Schema.String.annotate({
      description: "Plain-text draft body, from 1 to 200,000 characters."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BODY_CHARS)),
    reply_to_message_ref: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Exact account-qualified message_ref returned by email_search or email_thread_read. The draft is a reply in that message's thread."
      }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024))
    ),
    attachments: EmailAttachmentsSchema,
    reply_all: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "With reply_to_message_ref: also address the original To and Cc, excluding the connected account. Defaults to false."
      })
    )
  })

export const gmailDraftTool = ({
  google,
  emails,
  files
}: {
  readonly google: GoogleToolConnections
  readonly emails: ReadonlyArray<string>
  readonly files: SharedFileAccess
}): ServerTool => {
  const card = async (
    input: GmailDraftRequest,
    ctx: ToolContext<ServerRunContext>
  ): Promise<ServerApprovalPrompt> => {
    const draft = await resolveDraft({ google, request: input, signal: ctx.signal })
    const attachments = await gmailFilesCard({
      services: files,
      ctx,
      refs: input.attachments ?? [],
      key: `email_draft:${ctx.toolCallId}`,
      intent: jsonArguments(input)
    })
    return {
      preview: `Save a draft to ${draft.to[0] ?? ""}`,
      presentation: {
        title: "Save this draft?",
        approve_label: "Save draft",
        fields: [
          { label: "From", value: draft.account },
          ...recipientPresentationFields("To", draft.to),
          ...recipientPresentationFields("Cc", draft.cc),
          { label: "Subject", value: draft.subject || "(no subject)" }
        ],
        attachments: attachments.attachments,
        body: { label: "Message", text: draft.body }
      },
      data: {
        draft_envelope: jsonArguments(draft),
        draft_request: jsonArguments(input),
        ...attachments.data
      }
    }
  }
  return defineGoogleTool({
    google,
    grant: { ...DRAFT_GRANT, target: (input) => ({ accountRef: draftAccountRef(input) }) },
    name: "email_draft",
    description: [
      "Save a plain-text email as a draft in the user's Gmail Drafts; it is never sent.",
      "Pass reply_to_message_ref to draft a reply in that thread.",
      "Use email_send or email_reply to send."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(draftParametersSchema(emails)),
    metadata: {
      effect: "external",
      display_name: "Save Email Draft",
      display: { mail: "draft" },
      kind: "tool",
      action: "write",
      approval_preview: "Save this Gmail draft.",
      source: "gmail",
      changes_state: true,
      target: "reported",
      concurrency_group: "gmail_write",
      destructive: false,
      default_approval: "ask",
      policy_scope: "external",
      permissions: ["email"],
      idempotent: false
    },
    approvalPrompt: (input, ctx) => card(input, ctx),
    execute: async (input, ctx, effects) => {
      const draft =
        ctx.approval?.data?.draft_envelope === undefined
          ? await resolveDraft({ google, request: input, signal: ctx.signal })
          : approvedDraft(input, ctx.approval.data)
      const attachments = await gmailFilesForExecution({
        services: files,
        ctx,
        refs: input.attachments ?? [],
        key: `email_draft:${ctx.toolCallId}`,
        intent: jsonArguments(input)
      })
      const saved = await createDraft({
        google,
        draft: { ...draft, attachments },
        messageId: localMessageId(ctx.toolCallId),
        signal: ctx.signal,
        effects
      })
      return {
        result: `Draft saved in ${saved.account}'s Gmail Drafts. It was not sent.`,
        preview: "Saved a draft",
        data: {
          account_ref: saved.account,
          draft_id: saved.draft_id,
          thread_ref: saved.thread_ref
        }
      }
    }
  })
}

const DraftEnvelopeSchema = Schema.Struct({
  account: Schema.NonEmptyString,
  to: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  cc: Schema.Array(Schema.NonEmptyString),
  subject: Schema.String,
  body: Schema.String,
  thread: Schema.optionalKey(
    Schema.Struct({
      id: Schema.NonEmptyString,
      inReplyTo: Schema.optionalKey(Schema.String),
      references: Schema.optionalKey(Schema.String)
    })
  )
})
const approvedDraft = (
  request: GmailDraftRequest,
  data: Readonly<Record<string, unknown>>
): DraftMessage => {
  const draft = Option.getOrUndefined(
    Schema.decodeUnknownOption(DraftEnvelopeSchema)(data.draft_envelope)
  )
  if (
    draft === undefined ||
    JSON.stringify(data.draft_request) !== JSON.stringify(jsonArguments(request))
  ) {
    throw toolRefusal(
      "The approved draft no longer matches this call. Nothing was saved. Ask again with the current draft.",
      "Approval mismatch"
    )
  }
  return draft
}
