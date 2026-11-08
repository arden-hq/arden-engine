import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { gmailThreadUrl, gmailViewUrl, type GoogleAccount } from "@arden-hq/protocol/google"
import { Schema } from "effect"

import { gmailThreadTarget } from "../connections/items/gmail.js"
import { MAX_CALL_TARGETS, type CallEffects } from "../execution/tool-effect.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import {
  optionalAccountRefDescription,
  requiredAccountRefDescription,
  googleServiceAccount
} from "./google-accounts.js"
import { defineGoogleTool, type GoogleGrantDescription } from "./google-tool-grant.js"
import {
  changeVerbs,
  flagLabelChanges,
  mergeLabelChanges,
  mergeRestoreGroups,
  resolveLabelIds,
  restoreGroups,
  type GmailLabel,
  type MailboxFlags,
  type MessageLabels,
  type RestoreGroup
} from "./google-gmail-labels.js"
import { GMAIL_API, header } from "./google-gmail-mime.js"
import { parseThreadRef, threadRef } from "./google-gmail-refs.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { toolRefusal } from "./tool-failure.js"

const MODIFY_GRANT = {
  grant: "gmail_modify",
  what: "change Gmail messages",
  note: "Approving asks Google to let Arden change this mail."
} as const satisfies GoogleGrantDescription
const MAX_THREADS = MAX_CALL_TARGETS
const MAX_LABELS = 20
const MAX_RESTORE_MESSAGES = 1_000
const CONCURRENCY = 4

const gmailAccount = (google: GoogleToolConnections, accountRef: string): GoogleAccount => {
  const account = googleServiceAccount({
    accounts: google.accounts(),
    accountRef,
    service: "gmail"
  })
  if (account === undefined)
    throw toolRefusal("Use the exact connected Gmail account email.", "Invalid Gmail account")
  return account
}

const threadCount = (count: number): string => `${countOf(count, "thread")}`

const sentence = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`

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

const listLabels = async ({
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
    type: label.type === "system" ? "system" : "user"
  }))
  return {
    account: response.account.email,
    labels: [...labels].sort(
      (left, right) =>
        Number(left.type === "user") - Number(right.type === "user") ||
        left.name.localeCompare(right.name)
    )
  }
}

interface ThreadState {
  readonly id: string
  readonly subject: string
  readonly from: string
  readonly labels: ReadonlyArray<string>
  readonly messages: ReadonlyArray<MessageLabels>
}

const readThread = async ({
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

const inBatches = async <A, B>(
  values: ReadonlyArray<A>,
  operation: (value: A) => Promise<B>,
  signal: AbortSignal
): Promise<ReadonlyArray<PromiseSettledResult<B>>> => {
  const settled: Array<PromiseSettledResult<B>> = []
  for (let offset = 0; offset < values.length; offset += CONCURRENCY) {
    if (signal.aborted) break
    settled.push(
      ...(await Promise.allSettled(values.slice(offset, offset + CONCURRENCY).map(operation)))
    )
  }
  return settled
}

const resolveTargets = (
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

const cardLines = (threads: ReadonlyArray<ThreadState | undefined>): string =>
  threads
    .map((item) =>
      item === undefined
        ? "(thread unavailable)"
        : `${item.subject}${item.from === "" ? "" : ` — ${item.from}`}`
    )
    .join("\n")

const cardThreads = async (
  google: GoogleToolConnections,
  account: string,
  ids: ReadonlyArray<string>,
  signal: AbortSignal
): Promise<ReadonlyArray<ThreadState | undefined>> =>
  (await inBatches(ids, (id) => readThread({ google, account, id, signal }), signal)).map((item) =>
    item.status === "fulfilled" ? item.value : undefined
  )

type WriteOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "interrupted"; readonly cause: unknown }

const settleWrite = (settled: PromiseSettledResult<unknown> | undefined): WriteOutcome => {
  if (settled === undefined) return { kind: "interrupted", cause: undefined }
  if (settled.status === "fulfilled") return { kind: "done" }
  if (settled.reason instanceof ToolExecutionError) {
    return { kind: "failed", reason: settled.reason.preview ?? settled.reason.message }
  }
  return { kind: "interrupted", cause: settled.reason }
}

const raiseIfNothingDone = (outcomes: ReadonlyArray<WriteOutcome>, signal: AbortSignal): void => {
  if (outcomes.some((outcome) => outcome.kind === "done")) return
  const stopped = outcomes.find((outcome) => outcome.kind === "interrupted")
  if (stopped?.kind === "interrupted" && stopped.cause !== undefined) throw stopped.cause
  signal.throwIfAborted()
}

const interruptedReason = "not attempted: the call was interrupted"

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

const updateParametersSchema = (emails: ReadonlyArray<string>) =>
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

const trashParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    account_ref: accountRefField(emails),
    thread_refs: threadRefsField("moved to Trash")
  })

export const gmailModifyTools = ({
  google,
  emails
}: {
  readonly google: GoogleToolConnections
  readonly emails: ReadonlyArray<string>
}): ReadonlyArray<ServerTool> => {
  const nameThreads = async (
    effects: CallEffects,
    account: string,
    ids: ReadonlyArray<string>,
    signal: AbortSignal
  ): Promise<ReadonlyArray<ThreadState | undefined>> => {
    const threads = await cardThreads(google, account, ids, signal)
    await Promise.all(
      ids.map((id, index) => {
        const read = threads[index]
        return effects.target({
          ...gmailThreadTarget(id),
          ...(read === undefined ? {} : { title: read.subject }),
          href: gmailThreadUrl(account, id)
        })
      })
    )
    return threads
  }
  type ThreadUpdate = {
    readonly account_ref: string
    readonly thread_refs: ReadonlyArray<string>
  } & MailboxFlags & {
      readonly add_labels?: ReadonlyArray<string>
      readonly remove_labels?: ReadonlyArray<string>
    }
  type UpdateInput = Omit<ThreadUpdate, "thread_refs"> & {
    readonly thread_refs?: ReadonlyArray<string>
    readonly restore?: ReadonlyArray<RestoreGroup>
  }
  const withThreads = (input: UpdateInput): ThreadUpdate => {
    const other = Object.keys(input).filter((key) => key !== "account_ref" && key !== "restore")
    if (input.restore !== undefined) {
      if (other.length > 0) {
        throw toolRefusal(
          "restore stands alone: pass only account_ref and restore.",
          "Invalid restore"
        )
      }
      return { ...input, thread_refs: [] }
    }
    if (input.thread_refs === undefined) {
      throw toolRefusal(
        "email_update needs thread_refs, or restore from an earlier email_update result.",
        "Nothing to change"
      )
    }
    return { ...input, thread_refs: input.thread_refs }
  }
  const plan = async (input: ThreadUpdate, signal: AbortSignal) => {
    const targets = resolveTargets(google, input)
    const named = [...(input.add_labels ?? []), ...(input.remove_labels ?? [])]
    const labels =
      named.length === 0
        ? []
        : (await listLabels({ google, accountRef: targets.account.email, signal })).labels
    const change = mergeLabelChanges(flagLabelChanges(input), {
      add: resolveLabelIds(input.add_labels ?? [], labels),
      remove: resolveLabelIds(input.remove_labels ?? [], labels)
    })
    return { ...targets, change }
  }
  const restoreTarget = (accountRef: string) => ({ account: gmailAccount(google, accountRef) })
  const restoreCard = (input: {
    readonly account_ref: string
    readonly restore: ReadonlyArray<RestoreGroup>
  }): ServerApprovalPrompt => {
    const target = restoreTarget(input.account_ref)
    const count = input.restore.reduce((sum, group) => sum + group.message_ids.length, 0)
    return {
      preview: `Restore ${countOf(count, "message")}`,
      presentation: {
        title: `Restore ${countOf(count, "message")} to how they were?`,
        approve_label: "Restore",
        fields: [{ label: "Account", value: target.account.email }]
      }
    }
  }
  const restore = async (
    accountRef: string,
    groups: ReadonlyArray<RestoreGroup>,
    signal: AbortSignal,
    effects: CallEffects
  ) => {
    const target = restoreTarget(accountRef)
    const count = groups.reduce((sum, group) => sum + group.message_ids.length, 0)
    await effects.target({
      source: "gmail",
      objectId: `restore:${target.account.email}`,
      title: `Restored earlier labels on ${countOf(count, "message")}`,
      href: gmailViewUrl(target.account.email, "all")
    })
    const batches = groups.flatMap((group) =>
      Array.from(
        { length: Math.ceil(group.message_ids.length / MAX_RESTORE_MESSAGES) },
        (_, i) => ({
          ...group,
          message_ids: group.message_ids.slice(
            i * MAX_RESTORE_MESSAGES,
            (i + 1) * MAX_RESTORE_MESSAGES
          )
        })
      )
    )
    const settled = await inBatches(
      batches,
      (batch) =>
        googleCall({
          google,
          service: "gmail",
          url: `${GMAIL_API}/messages/batchModify`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ids: batch.message_ids,
              addLabelIds: batch.add_labels,
              removeLabelIds: batch.remove_labels
            })
          },
          accountRef: target.account.email,
          signal,
          effects
        }),
      signal
    )
    const outcomes = batches.map((_, index) => settleWrite(settled[index]))
    raiseIfNothingDone(outcomes, signal)
    const restored = batches.reduce(
      (sum, batch, index) =>
        sum + (outcomes[index]?.kind === "done" ? batch.message_ids.length : 0),
      0
    )
    const total = batches.reduce((sum, batch) => sum + batch.message_ids.length, 0)
    return {
      result:
        restored === total
          ? `Restored ${countOf(restored, "message")} to their earlier labels.`
          : `Restored ${restored} of ${total} messages; the rest were not changed.`,
      preview: `Restored ${restored} of ${total}`,
      data: { account_ref: target.account.email, restored, total }
    }
  }
  const updateCard = async (
    input: UpdateInput,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    if (input.restore !== undefined) {
      withThreads(input)
      return restoreCard({ account_ref: input.account_ref, restore: input.restore })
    }
    const target = await plan(withThreads(input), signal)
    const { account, ids } = target
    const threads = await cardThreads(google, account.email, ids, signal)
    const what = sentence(changeVerbs(input).join(", "))
    return {
      preview: `${what}: ${threadCount(ids.length)}`,
      presentation: {
        title: `${what} ${threadCount(ids.length)}?`,
        approve_label: "Update",
        fields: [{ label: "Account", value: account.email }],
        body: { label: "Threads", text: cardLines(threads) }
      }
    }
  }
  const trashCard = async (
    input: { readonly account_ref: string; readonly thread_refs: ReadonlyArray<string> },
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const target = resolveTargets(google, input)
    const { account, ids } = target
    const threads = await cardThreads(google, account.email, ids, signal)
    return {
      preview: `Trash ${threadCount(ids.length)}`,
      presentation: {
        title: `Move ${threadCount(ids.length)} to Trash?`,
        approve_label: "Move to Trash",
        fields: [
          { label: "Account", value: account.email },
          { label: "Kept", value: "30 days in Gmail Trash, then deleted" }
        ],
        body: { label: "Threads", text: cardLines(threads) }
      }
    }
  }
  return [
    defineServerTool({
      name: "email_label_list",
      description: [
        "List the Gmail labels of one account: name, id and type (system or user).",
        "Use the names or ids with email_update add_labels and remove_labels."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(
        Schema.Struct({
          account_ref: Schema.optionalKey(
            Schema.String.annotate({
              description: optionalAccountRefDescription("gmail", emails)
            }).check(Schema.isMinLength(1), Schema.isMaxLength(320))
          )
        })
      ),
      metadata: {
        effect: "none",
        background: true,
        display_name: "List Gmail Labels",
        kind: "tool",
        action: "read",
        approval_preview: "List Gmail labels.",
        source: "gmail",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        policy_scope: "external",
        permissions: ["email"]
      },
      execute: async (input, ctx) => {
        const listed = await listLabels({
          google,
          accountRef: input.account_ref,
          signal: ctx.signal
        })
        return {
          result:
            listed.labels.length === 0
              ? "No Gmail labels."
              : listed.labels
                  .map((label) => `${label.name} [${label.id}] (${label.type})`)
                  .join("\n"),
          preview: `${countOf(listed.labels.length, "label")}`,
          data: { account_ref: listed.account, labels: listed.labels }
        }
      }
    }),
    defineGoogleTool({
      google,
      grant: { ...MODIFY_GRANT, target: (input) => ({ accountRef: input.account_ref }) },
      name: "email_update",
      description: [
        "Change the mailbox state of Gmail conversations in one batch: archive, mark read or unread, star, mark important, add or remove existing labels.",
        `Pass up to ${MAX_THREADS} thread_refs and every change at once. The result carries a restore array; to undo exactly, call email_update again with account_ref and that restore alone, which gives every message its own earlier labels back.`,
        "Archive before trashing."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(updateParametersSchema(emails)),
      metadata: {
        effect: "external",
        display_name: "Update Email",
        kind: "tool",
        action: "write",
        approval_preview: "Change these Gmail threads.",
        source: "gmail",
        changes_state: true,
        concurrency_group: "gmail_write",
        destructive: true,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["email"],
        idempotent: true,
        target: "reported"
      },
      approvalPrompt: (input, ctx) => updateCard(input, ctx.signal),
      execute: async (input, ctx, effects) => {
        if (input.restore !== undefined) {
          withThreads(input)
          return restore(input.account_ref, input.restore, ctx.signal, effects)
        }
        const target = await plan(withThreads(input), ctx.signal)
        const { account, ids, change } = target
        const read = await nameThreads(effects, account.email, ids, ctx.signal)
        const settled = await inBatches(
          ids.map((id, index) => ({ id, read: read[index] })),
          async ({ id, read: named }) => {
            const before =
              named ??
              (await readThread({ google, account: account.email, id, signal: ctx.signal }))
            await googleCall({
              google,
              service: "gmail",
              url: `${GMAIL_API}/threads/${encodeURIComponent(id)}/modify`,
              init: {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ addLabelIds: change.add, removeLabelIds: change.remove })
              },
              accountRef: account.email,
              signal: ctx.signal,
              effects
            })
            return before
          },
          ctx.signal
        )
        const outcomes = ids.map((_, index) => settleWrite(settled[index]))
        raiseIfNothingDone(outcomes, ctx.signal)
        const threads = ids.map((id, index) => {
          const done = settled[index]
          const outcome = outcomes[index]
          const ref = threadRef(account.email, id)
          if (done?.status === "fulfilled") {
            return {
              thread_ref: ref,
              changed: true as const,
              subject: done.value.subject,
              labels_before: done.value.labels,
              restore: restoreGroups(done.value.messages, change)
            }
          }
          return {
            thread_ref: ref,
            changed: false as const,
            reason: outcome?.kind === "failed" ? outcome.reason : interruptedReason
          }
        })
        const changedThreads = threads.flatMap((item) => (item.changed ? [item] : []))
        const failed = threads.length - changedThreads.length
        const restoreAll = mergeRestoreGroups(changedThreads.flatMap((item) => item.restore))
        const lines = threads.map((item) =>
          item.changed
            ? `[${item.thread_ref}] ${item.subject} — labels before: ${item.labels_before.join(", ") || "none"}`
            : `[${item.thread_ref}] not changed: ${item.reason}`
        )
        return {
          result: [
            `${sentence(changeVerbs(input).join(", "))}: ${threadCount(changedThreads.length)} changed${failed === 0 ? "" : `, ${failed} not changed`}.`,
            restoreAll.length === 0
              ? "Nothing to restore."
              : `To undo exactly, call email_update with account_ref and restore = ${JSON.stringify(restoreAll)}.`,
            ...lines
          ].join("\n"),
          preview: `Updated ${threadCount(changedThreads.length)}${failed === 0 ? "" : ` (${failed} not changed)`}`,
          data: {
            account_ref: account.email,
            added_label_ids: change.add,
            removed_label_ids: change.remove,
            restore: restoreAll,
            threads
          }
        }
      }
    }),
    defineGoogleTool({
      google,
      grant: { ...MODIFY_GRANT, target: (input) => ({ accountRef: input.account_ref }) },
      name: "email_trash",
      description: [
        "Move Gmail conversations to Trash, where Gmail keeps them 30 days before deleting them.",
        `Pass up to ${MAX_THREADS} thread_refs. There is no permanent delete. Prefer email_update archive for mail the user may want again.`
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(trashParametersSchema(emails)),
      metadata: {
        effect: "external",
        display_name: "Trash Email",
        kind: "tool",
        action: "write",
        approval_preview: "Move these Gmail threads to Trash.",
        source: "gmail",
        changes_state: true,
        concurrency_group: "gmail_write",
        destructive: true,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["email"],
        idempotent: true,
        target: "reported"
      },
      approvalPrompt: (input, ctx) => trashCard(input, ctx.signal),
      execute: async (input, ctx, effects) => {
        const target = resolveTargets(google, input)
        const { account, ids } = target
        await nameThreads(effects, account.email, ids, ctx.signal)
        const outcomes = await inBatches(
          ids,
          (id) =>
            googleCall({
              google,
              service: "gmail",
              url: `${GMAIL_API}/threads/${encodeURIComponent(id)}/trash`,
              init: { method: "POST" },
              accountRef: account.email,
              signal: ctx.signal,
              effects
            }),
          ctx.signal
        )
        const results = ids.map((_, index) => settleWrite(outcomes[index]))
        raiseIfNothingDone(results, ctx.signal)
        const threads = ids.map((id, index) => {
          const outcome = results[index]
          return {
            thread_ref: threadRef(account.email, id),
            trashed: outcome?.kind === "done",
            ...(outcome?.kind === "done"
              ? {}
              : { reason: outcome?.kind === "failed" ? outcome.reason : interruptedReason })
          }
        })
        const trashed = threads.filter((item) => item.trashed).length
        return {
          result: [
            `Moved ${threadCount(trashed)} to Gmail Trash${trashed === threads.length ? "" : `; ${threads.length - trashed} failed`}.`,
            "Gmail keeps them 30 days; the user can restore them from Trash.",
            ...threads.flatMap((item) =>
              item.trashed ? [] : [`[${item.thread_ref}] not trashed: ${item.reason ?? "failed"}`]
            )
          ].join("\n"),
          preview: `Trashed ${threadCount(trashed)}`,
          data: { account_ref: account.email, threads }
        }
      }
    })
  ]
}
