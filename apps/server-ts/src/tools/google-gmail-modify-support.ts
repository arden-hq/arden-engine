import { isFulfilled } from "@arden-hq/std/attempt"
import { countOf } from "@arden-hq/std/count"
import { type GoogleAccount } from "@arden-hq/protocol/google"
import { Schema } from "effect"

import { MAX_CALL_TARGETS } from "../execution/tool-effect.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { requiredAccountRefDescription, googleServiceAccount } from "./google-accounts.js"
import { type GoogleGrantDescription } from "./google-tool-grant.js"
import {
  type GmailLabel,
  type MessageLabels,
  compareLabels,
  gmailLabelType
} from "./google-gmail-labels.js"
import { GMAIL_API, header } from "./google-gmail-mime.js"
import { parseThreadRef } from "./google-gmail-refs.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { toolRefusal } from "./tool-failure.js"
import { inBatches } from "./google-gmail-batches.js"

export const MODIFY_GRANT: GoogleGrantDescription = {
  grant: "gmail_modify",
  what: "change Gmail messages",
  note: "Approving asks Google to let Arden change this mail."
}
export const MAX_THREADS = MAX_CALL_TARGETS
const MAX_LABELS = 20
export const MAX_RESTORE_MESSAGES = 1_000

export const gmailAccount = (google: GoogleToolConnections, accountRef: string): GoogleAccount => {
  const account = googleServiceAccount({
    accounts: google.accounts(),
    accountRef,
    service: "gmail"
  })
  if (account === undefined)
    throw toolRefusal("Use the exact connected Gmail account email.", "Invalid Gmail account")
  return account
}

export const threadCount = (count: number): string => `${countOf(count, "thread")}`

export const sentence = (text: string): string =>
  `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`

const decodeLabels = decodeGoogle(
  Schema.Struct({
    labels: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: Schema.NonEmptyString,
          name: Schema.String,
          type: Schema.optionalKey(Schema.String)
        })
      )
    )
  }),
  { service: "gmail", label: "label list" }
)

const decodeThreadSummary = decodeGoogle(
  Schema.Struct({
    id: Schema.NonEmptyString,
    messages: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: Schema.NonEmptyString,
          labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
          payload: Schema.optionalKey(
            Schema.Struct({
              headers: Schema.optionalKey(
                Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }))
              )
            })
          )
        })
      )
    )
  }),
  { service: "gmail", label: "thread" }
)

export const listLabels = async ({
  google,
  accountRef,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly accountRef: string | undefined
  readonly signal: AbortSignal
}): Promise<{ readonly account: string; readonly labels: ReadonlyArray<GmailLabel> }> => {
  const response = await googleCall({
    google,
    service: "gmail",
    url: `${GMAIL_API}/labels`,
    accountRef,
    signal
  })
  const labels = (decodeLabels(response.value).labels ?? []).map((label): GmailLabel => ({
    id: label.id,
    name: label.name,
    type: gmailLabelType(label.type)
  }))
  return {
    account: response.account.email,
    labels: [...labels].sort(compareLabels)
  }
}

export interface ThreadState {
  readonly id: string
  readonly subject: string
  readonly from: string
  readonly labels: ReadonlyArray<string>
  readonly messages: ReadonlyArray<MessageLabels>
}

export const readThread = async ({
  google,
  account,
  id,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly account: string
  readonly id: string
  readonly signal: AbortSignal
}): Promise<ThreadState> => {
  const url = new URL(`${GMAIL_API}/threads/${encodeURIComponent(id)}`)
  url.searchParams.set("format", "metadata")
  for (const name of ["From", "Subject"]) url.searchParams.append("metadataHeaders", name)
  const thread = decodeThreadSummary(
    (await googleCall({ google, service: "gmail", url: url.href, accountRef: account, signal }))
      .value
  )
  const messages = thread.messages ?? []
  return {
    id: thread.id,
    subject: header(messages[0]?.payload, "Subject") ?? "(no subject)",
    from: header(messages[0]?.payload, "From") ?? "",
    labels: [...new Set(messages.flatMap((item) => item.labelIds ?? []))],
    messages: messages.map((item) => ({ id: item.id, labels: item.labelIds ?? [] }))
  }
}

export const resolveTargets = (
  google: GoogleToolConnections,
  input: { readonly account_ref: string; readonly thread_refs: ReadonlyArray<string> }
): {
  readonly account: GoogleAccount
  readonly ids: ReadonlyArray<string>
} => {
  const account = gmailAccount(google, input.account_ref)
  const ids = new Set<string>()
  for (const value of input.thread_refs) {
    const ref = parseThreadRef(value)
    if (ref.account.toLowerCase() !== account.email.toLowerCase()) {
      throw toolRefusal(
        `thread_ref ${value} belongs to ${ref.account}, not ${account.email}. Use one account per call.`,
        "Account mismatch"
      )
    }
    ids.add(ref.id)
  }
  return { account, ids: [...ids] }
}

export const cardLines = (threads: ReadonlyArray<ThreadState | undefined>): string =>
  threads
    .map((item) =>
      item === undefined
        ? "(thread unavailable)"
        : `${item.subject}${item.from === "" ? "" : ` — ${item.from}`}`
    )
    .join("\n")

export const cardThreads = async (
  google: GoogleToolConnections,
  account: string,
  ids: ReadonlyArray<string>,
  signal: AbortSignal
): Promise<ReadonlyArray<ThreadState | undefined>> =>
  (await inBatches(ids, (id) => readThread({ google, account, id, signal }), signal)).map((item) =>
    isFulfilled(item) ? item.value : undefined
  )

const accountRefField = (emails: ReadonlyArray<string>) =>
  Schema.String.annotate({
    description: requiredAccountRefDescription(
      "gmail",
      "Exact email address of the connected Gmail account that owns the threads. Every thread_ref must belong to it.",
      emails
    )
  }).check(Schema.isMinLength(1), Schema.isMaxLength(320))

const threadRefsField = (verb: string) =>
  Schema.Array(Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(2_048)))
    .annotate({
      description: `Exact thread_ref values returned by email_thread_search, email_search or email_thread_read, 1 to ${MAX_THREADS}. Every thread is ${verb}.`
    })
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_THREADS))

const flag = (description: string) => Schema.optionalKey(Schema.Boolean.annotate({ description }))

const labelNamesField = (description: string) =>
  Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(225)))
      .annotate({ description })
      .check(Schema.isMaxLength(MAX_LABELS))
  )

export type UpdateParametersSchema = Schema.Struct<{
  readonly account_ref: Schema.String
  readonly thread_refs: Schema.optionalKey<Schema.$Array<Schema.String>>
  readonly archive: Schema.optionalKey<Schema.Boolean>
  readonly read: Schema.optionalKey<Schema.Boolean>
  readonly starred: Schema.optionalKey<Schema.Boolean>
  readonly important: Schema.optionalKey<Schema.Boolean>
  readonly add_labels: Schema.optionalKey<Schema.$Array<Schema.String>>
  readonly remove_labels: Schema.optionalKey<Schema.$Array<Schema.String>>
  readonly restore: Schema.optionalKey<
    Schema.$Array<
      Schema.Struct<{
        readonly message_ids: Schema.$Array<Schema.NonEmptyString>
        readonly add_labels: Schema.$Array<Schema.NonEmptyString>
        readonly remove_labels: Schema.$Array<Schema.NonEmptyString>
      }>
    >
  >
}>

export const updateParametersSchema = (emails: ReadonlyArray<string>): UpdateParametersSchema =>
  Schema.Struct({
    account_ref: accountRefField(emails),
    thread_refs: Schema.optionalKey(threadRefsField("changed")),
    archive: flag("true removes the threads from the Inbox; false moves them back to the Inbox."),
    read: flag("true marks the threads read; false marks them unread."),
    starred: flag("true stars the threads; false removes the star."),
    important: flag("true marks the threads important; false marks them not important."),
    add_labels: labelNamesField(
      "Names or ids of existing labels to add. See email_label_list. Unknown labels are an error; labels are never created."
    ),
    remove_labels: labelNamesField("Names or ids of existing labels to remove."),
    restore: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          message_ids: Schema.Array(Schema.NonEmptyString).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(MAX_RESTORE_MESSAGES)
          ),
          add_labels: Schema.Array(Schema.NonEmptyString),
          remove_labels: Schema.Array(Schema.NonEmptyString)
        })
      )
        .annotate({
          description:
            "Undo of an earlier email_update: pass the restore array from its result exactly, with account_ref, and nothing else. Each message gets its own earlier labels back."
        })
        .check(Schema.isMinLength(1), Schema.isMaxLength(20))
    )
  })

export type TrashParametersSchema = Schema.Struct<{
  readonly account_ref: Schema.String
  readonly thread_refs: Schema.$Array<Schema.String>
}>

export const trashParametersSchema = (emails: ReadonlyArray<string>): TrashParametersSchema =>
  Schema.Struct({
    account_ref: accountRefField(emails),
    thread_refs: threadRefsField("moved to Trash")
  })
