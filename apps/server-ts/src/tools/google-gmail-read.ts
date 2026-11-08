import { countOf } from "@arden-hq/std/count"
import { cutBytes, foldSpace } from "@arden-hq/std/text"
import { ToolExecutionError } from "@arden-hq/loop"
import { emailSource } from "./google-gmail-source.js"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { optionalAccountRefDescription } from "./google-accounts.js"
import {
  attachmentMetadata,
  boundedRenderedMessage,
  boundedThreadBody,
  chronologicalMessages,
  GMAIL_API,
  header,
  message,
  messageDate,
  payloadText,
  thread
} from "./google-gmail-mime.js"
import {
  decodePageRef,
  decodeThreadPageRef,
  GmailSearchLimitSchema,
  messageRef,
  parseMessageRef,
  parseThreadRef,
  threadPageRef,
  threadRef
} from "./google-gmail-refs.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { passage, unquotedEmail } from "./source-passage.js"
import { encodeOpaque } from "../lib/opaque-ref.js"
import { toolFault, toolRefusal } from "./tool-failure.js"

const MAX_THREAD_PAGE_CONTENT_BYTES = 36 * 1_024
const METADATA_CONCURRENCY = 4
const MAX_SEARCH_SNIPPET_BYTES = 160

const searchSnippet = (snippet: string): string =>
  cutBytes(foldSpace(snippet), MAX_SEARCH_SNIPPET_BYTES)

const renderAttachments = (files: ReturnType<typeof attachmentMetadata>): string =>
  [
    "Attachments:",
    ...files.map(
      (file) =>
        `${file.index}. ${file.filename} · ${file.mime_type} · ${file.byte_length === null ? "size unknown" : `${file.byte_length} bytes`}`
    )
  ].join("\n")

const accountRefSchema = (emails: ReadonlyArray<string>) =>
  Schema.optionalKey(
    Schema.String.annotate({
      description: optionalAccountRefDescription("gmail", emails)
    }).check(Schema.isMinLength(1), Schema.isMaxLength(320))
  )
const searchParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
      .pipe(Schema.withDecodingDefault(Effect.succeed("newer_than:7d")))
      .pipe(
        Schema.annotateEncoded({
          description:
            "Gmail search query, including Gmail operators such as from:, is:, and newer_than:. Narrow the query for targeted lookup. Defaults to newer_than:7d."
        })
      ),
    limit: Schema.optionalKey(GmailSearchLimitSchema),
    account_ref: accountRefSchema(emails),
    page_ref: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Use the opaque next_page_ref from the same search tool when more matches are needed. Reuse the query and omit limit and account_ref to inherit them from the cursor."
      }).check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
    )
  })
const ReadParametersSchema = Schema.Struct({
  message_ref: Schema.String.annotate({
    description:
      "Exact account-qualified message_ref returned by email_search or email_thread_read."
  }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024))
})
const ThreadReadParametersSchema = Schema.Struct({
  thread_ref: Schema.String.annotate({
    description:
      "Exact thread_ref returned by email_search, email_thread_search, or email_thread_read."
  }).check(Schema.isMinLength(3), Schema.isMaxLength(2_048)),
  page_ref: Schema.optionalKey(
    Schema.String.annotate({
      description: "Opaque next_page_ref returned by email_thread_read for this same thread."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
  )
})

const GmailIdsSchema = Schema.optionalKey(
  Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))
)
const messageList = decodeGoogle(
  Schema.Struct({ messages: GmailIdsSchema, nextPageToken: Schema.optionalKey(Schema.String) }),
  { service: "gmail", label: "message list" }
)
const threadList = decodeGoogle(
  Schema.Struct({ threads: GmailIdsSchema, nextPageToken: Schema.optionalKey(Schema.String) }),
  { service: "gmail", label: "thread list" }
)

const settledInBatches = async <A, B>(
  values: ReadonlyArray<A>,
  operation: (value: A) => Promise<B>,
  signal: AbortSignal
): Promise<ReadonlyArray<PromiseSettledResult<B>>> => {
  const settled: Array<PromiseSettledResult<B>> = []
  for (let offset = 0; offset < values.length; offset += METADATA_CONCURRENCY) {
    signal.throwIfAborted()
    settled.push(
      ...(await Promise.allSettled(
        values.slice(offset, offset + METADATA_CONCURRENCY).map(operation)
      ))
    )
    signal.throwIfAborted()
  }
  return settled
}

export const gmailReadTools = ({
  google,
  emails
}: {
  readonly google: GoogleToolConnections
  readonly emails: ReadonlyArray<string>
}): ReadonlyArray<ServerTool> => {
  const SearchParametersSchema = searchParametersSchema(emails)
  return [
    defineServerTool({
      name: "email_search",
      description: [
        "Search individual Gmail messages with Gmail query syntax.",
        "Returns message_ref for email_read or email_reply and thread_ref for conversation reads; use email_thread_search for one result per conversation."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(SearchParametersSchema),
      metadata: {
        effect: "none",
        display_name: "Search Gmail",
        kind: "tool",
        action: "read",
        approval_preview: "Search connected Gmail accounts.",
        source: "gmail",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        policy_scope: "external",
        permissions: ["email"]
      },
      execute: async (input, ctx) => {
        const page = decodePageRef(
          input.page_ref,
          "messages",
          input.query,
          input.limit,
          input.account_ref
        )
        const url = new URL(`${GMAIL_API}/messages`)
        url.searchParams.set("q", input.query)
        url.searchParams.set("maxResults", String(page.limit))
        if (page.token !== undefined) url.searchParams.set("pageToken", page.token)
        const listed = await googleCall({
          google,
          service: "gmail",
          url: url.href,
          accountRef: page.accountRef,
          signal: ctx.signal
        })
        const source = messageList(listed.value)
        const ids = (source.messages ?? []).map((item) => item.id)
        const settled = await settledInBatches(
          ids,
          async (id) => {
            const itemUrl = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`)
            itemUrl.searchParams.set("format", "metadata")
            for (const name of ["From", "To", "Subject"])
              itemUrl.searchParams.append("metadataHeaders", name)
            const item = message(
              (
                await googleCall({
                  google,
                  service: "gmail",
                  url: itemUrl.href,
                  accountRef: listed.account.email,
                  signal: ctx.signal
                })
              ).value
            )
            const found = {
              message_ref: messageRef(listed.account.email, item.id),
              thread_ref: threadRef(listed.account.email, item.threadId),
              from: header(item.payload, "From") ?? "",
              to: header(item.payload, "To") ?? "",
              subject: header(item.payload, "Subject") ?? "(no subject)",
              received_at: messageDate(item.internalDate),
              snippet: item.snippet ?? ""
            }
            const source = emailSource({
              use: "found",
              kind: "message",
              ref: found.message_ref,
              account: listed.account.email,
              threadId: item.threadId,
              subject: found.subject,
              from: found.from,
              receivedAt: found.received_at
            })
            return { found, source }
          },
          ctx.signal
        )
        const hits = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))
        const messages = hits.map((hit) => hit.found)
        const source_refs = hits.map((hit) => hit.source)
        const failures = settled.filter((item) => item.status === "rejected")
        if (messages.length === 0 && failures.length > 0) {
          const failure = failures[0]?.reason
          throw failure instanceof ToolExecutionError
            ? failure
            : toolFault("Gmail messages could not be loaded.", "Gmail unavailable")
        }
        const failureReasons = [
          ...new Set(
            failures.map((item) =>
              item.reason instanceof ToolExecutionError
                ? (item.reason.preview ?? "Gmail message unavailable")
                : "Gmail message unavailable"
            )
          )
        ]
        const nextPageRef =
          source.nextPageToken === undefined
            ? null
            : encodeOpaque({
                version: 1,
                resource: "messages",
                account: listed.account.email,
                query: input.query,
                limit: page.limit,
                token: source.nextPageToken
              })
        const lines =
          messages.length === 0
            ? ["No matching email."]
            : messages.map((item) =>
                [
                  `message_ref: ${item.message_ref}`,
                  `Subject: ${item.subject}`,
                  `From: ${item.from}`,
                  `Thread: ${item.thread_ref}`,
                  `${item.received_at ?? "Unknown date"} · ${searchSnippet(item.snippet)}`
                ].join("\n")
              )
        if (failures.length > 0) {
          lines.unshift(
            `Partial results: ${failures.length} of ${ids.length} matching emails could not be loaded (${failureReasons.join(", ")}).`
          )
        }
        if (nextPageRef !== null) lines.push(`Next page_ref: ${nextPageRef}`)
        return {
          host: { source_refs },
          result: lines.join("\n\n"),
          preview: `${countOf(messages.length, "email")}${failures.length === 0 ? "" : " (partial)"}`,
          data: {
            account_ref: listed.account.email,
            messages,
            source_refs,
            next_page_ref: nextPageRef,
            incomplete: failures.length > 0,
            failed_message_count: failures.length,
            failure_reasons: failureReasons
          }
        }
      }
    }),
    defineServerTool({
      name: "email_thread_search",
      description: [
        "Search distinct Gmail conversations with Gmail query syntax and return one thread_ref per conversation.",
        "Use email_search when individual matching messages matter."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(SearchParametersSchema),
      metadata: {
        effect: "none",
        display_name: "Search Gmail Threads",
        kind: "tool",
        action: "read",
        approval_preview: "Search connected Gmail conversations.",
        source: "gmail",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        policy_scope: "external",
        permissions: ["email"]
      },
      execute: async (input, ctx) => {
        const page = decodePageRef(
          input.page_ref,
          "threads",
          input.query,
          input.limit,
          input.account_ref
        )
        const url = new URL(`${GMAIL_API}/threads`)
        url.searchParams.set("q", input.query)
        url.searchParams.set("maxResults", String(page.limit))
        if (page.token !== undefined) url.searchParams.set("pageToken", page.token)
        const listed = await googleCall({
          google,
          service: "gmail",
          url: url.href,
          accountRef: page.accountRef,
          signal: ctx.signal
        })
        const source = threadList(listed.value)
        const ids = (source.threads ?? []).map((item) => item.id)
        const settled = await settledInBatches(
          ids,
          async (id) => {
            const itemUrl = new URL(`${GMAIL_API}/threads/${encodeURIComponent(id)}`)
            itemUrl.searchParams.set("format", "metadata")
            for (const name of ["From", "To", "Cc", "Subject"]) {
              itemUrl.searchParams.append("metadataHeaders", name)
            }
            const item = thread(
              (
                await googleCall({
                  google,
                  service: "gmail",
                  url: itemUrl.href,
                  accountRef: listed.account.email,
                  signal: ctx.signal
                })
              ).value
            )
            if (item.id !== id)
              throw toolRefusal("Gmail returned a different thread.", "Invalid Gmail response")
            const messages = chronologicalMessages(item.messages)
            const latest = messages.at(-1)
            const found = {
              thread_ref: threadRef(listed.account.email, item.id),
              subject: header(latest?.payload, "Subject") ?? "(no subject)",
              message_count: messages.length,
              latest_from: header(latest?.payload, "From") ?? "",
              latest_at: messageDate(latest?.internalDate),
              snippet: latest?.snippet ?? item.snippet ?? ""
            }
            const source = emailSource({
              use: "found",
              kind: "thread",
              ref: found.thread_ref,
              account: listed.account.email,
              threadId: item.id,
              subject: found.subject,
              from: found.latest_from,
              receivedAt: found.latest_at
            })
            return { found, source }
          },
          ctx.signal
        )
        const hits = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))
        const threads = hits.map((hit) => hit.found)
        const source_refs = hits.map((hit) => hit.source)
        const failures = settled.filter((item) => item.status === "rejected")
        if (threads.length === 0 && failures.length > 0) {
          const failure = failures[0]?.reason
          throw failure instanceof ToolExecutionError
            ? failure
            : toolFault("Gmail threads could not be loaded.", "Gmail unavailable")
        }
        const failureReasons = [
          ...new Set(
            failures.map((item) =>
              item.reason instanceof ToolExecutionError
                ? (item.reason.preview ?? "Gmail thread unavailable")
                : "Gmail thread unavailable"
            )
          )
        ]
        const nextPageRef =
          source.nextPageToken === undefined
            ? null
            : encodeOpaque({
                version: 1,
                resource: "threads",
                account: listed.account.email,
                query: input.query,
                limit: page.limit,
                token: source.nextPageToken
              })
        const lines =
          threads.length === 0
            ? ["No matching email threads."]
            : threads.map((item) =>
                [
                  `[${item.thread_ref}] ${item.subject}`,
                  `${countOf(item.message_count, "message")} · Latest from: ${item.latest_from || "unknown"}`,
                  `${item.latest_at ?? "Unknown date"} · ${searchSnippet(item.snippet)}`
                ].join("\n")
              )
        if (failures.length > 0) {
          lines.unshift(
            `Partial results: ${failures.length} of ${ids.length} matching threads could not be loaded (${failureReasons.join(", ")}).`
          )
        }
        if (nextPageRef !== null) lines.push(`Next page_ref: ${nextPageRef}`)
        return {
          host: { source_refs },
          result: lines.join("\n\n"),
          preview: `${countOf(threads.length, "thread")}${failures.length === 0 ? "" : " (partial)"}`,
          data: {
            account_ref: listed.account.email,
            threads,
            source_refs,
            next_page_ref: nextPageRef,
            incomplete: failures.length > 0,
            failed_thread_count: failures.length,
            failure_reasons: failureReasons
          }
        }
      }
    }),
    defineServerTool({
      name: "email_read",
      description: [
        "Read headers, attachment names, and up to 200,000 characters of body for one Gmail message_ref.",
        "Use email_thread_read to read the complete conversation in chronological order."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(ReadParametersSchema),
      metadata: {
        effect: "none",
        background: true,
        display_name: "Read Email",
        kind: "tool",
        action: "read",
        approval_preview: "Read this Gmail message.",
        source: "gmail",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        policy_scope: "external",
        permissions: ["email"]
      },
      execute: async (input, ctx) => {
        const ref = parseMessageRef(input.message_ref)
        const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(ref.id)}`)
        url.searchParams.set("format", "full")
        const response = await googleCall({
          google,
          service: "gmail",
          url: url.href,
          accountRef: ref.account,
          signal: ctx.signal
        })
        const item = message(response.value)
        if (item.id !== ref.id)
          throw toolRefusal("Gmail returned a different message.", "Invalid Gmail response")
        const content = payloadText(item.payload)
        const details = {
          message_ref: input.message_ref,
          thread_ref: threadRef(response.account.email, item.threadId),
          from: header(item.payload, "From") ?? "",
          to: header(item.payload, "To") ?? "",
          cc: header(item.payload, "Cc") ?? "",
          subject: header(item.payload, "Subject") ?? "(no subject)",
          received_at: messageDate(item.internalDate),
          body: content.text,
          attachments: content.attachments,
          attachment_details: attachmentMetadata(item.payload)
        }
        const source_refs = [
          emailSource({
            use: "read",
            kind: "message",
            ref: input.message_ref,
            account: response.account.email,
            threadId: item.threadId,
            subject: details.subject,
            from: details.from,
            body: details.body,
            receivedAt: details.received_at
          })
        ]
        return {
          host: { source_refs },
          result: [
            `From: ${details.from}`,
            `To: ${details.to}`,
            ...(details.cc === "" ? [] : [`Cc: ${details.cc}`]),
            `Subject: ${details.subject}`,
            `Thread: ${details.thread_ref}`,
            "",
            details.body,
            ...(details.attachments.length === 0
              ? []
              : ["", renderAttachments(details.attachment_details)])
          ].join("\n"),
          preview: details.subject,
          data: { ...details, source_refs }
        }
      }
    }),
    defineServerTool({
      name: "email_thread_read",
      description: [
        "Read one chronological Gmail conversation page, capped near 36 KiB with each message body capped at 16 KiB.",
        "Continue with next_page_ref when present; use email_read when only one message is needed."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(ThreadReadParametersSchema),
      metadata: {
        effect: "none",
        background: true,
        display_name: "Read Gmail Thread",
        kind: "tool",
        action: "read",
        approval_preview: "Read this Gmail conversation.",
        source: "gmail",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        policy_scope: "external",
        permissions: ["email"]
      },
      execute: async (input, ctx) => {
        const ref = parseThreadRef(input.thread_ref)
        const offset = decodeThreadPageRef(input.page_ref, ref)
        const url = new URL(`${GMAIL_API}/threads/${encodeURIComponent(ref.id)}`)
        url.searchParams.set("format", "full")
        const response = await googleCall({
          google,
          service: "gmail",
          url: url.href,
          accountRef: ref.account,
          signal: ctx.signal
        })
        const item = thread(response.value)
        if (item.id !== ref.id)
          throw toolRefusal("Gmail returned a different thread.", "Invalid Gmail response")
        const messages = chronologicalMessages(item.messages).map((entry) => {
          const content = payloadText(entry.payload)
          const body = boundedThreadBody(content.text)
          return {
            message_ref: messageRef(response.account.email, entry.id),
            from: header(entry.payload, "From") ?? "",
            to: header(entry.payload, "To") ?? "",
            cc: header(entry.payload, "Cc") ?? "",
            subject: header(entry.payload, "Subject") ?? "(no subject)",
            received_at: messageDate(entry.internalDate),
            body: body.text,
            body_truncated: body.truncated,
            attachments: content.attachments,
            attachment_details: attachmentMetadata(entry.payload)
          }
        })
        if (messages.length === 0) {
          throw toolRefusal("Gmail returned an empty thread.", "Invalid Gmail response")
        }
        if (offset >= messages.length) {
          throw toolRefusal(
            "The Gmail page_ref starts beyond this thread.",
            "Invalid page reference"
          )
        }
        const rendered: string[] = []
        const pageMessages: typeof messages = []
        let renderedBytes = 0
        let outputTruncated = false
        for (const [position, entry] of messages.slice(offset).entries()) {
          const index = offset + position
          const bounded = boundedRenderedMessage(
            [
              `Message ${index + 1} of ${messages.length}`,
              `message_ref: ${entry.message_ref}`,
              `From: ${entry.from}`,
              `To: ${entry.to}`,
              ...(entry.cc === "" ? [] : [`Cc: ${entry.cc}`]),
              `Date: ${entry.received_at ?? "Unknown date"}`,
              `Subject: ${entry.subject}`,
              ...(entry.attachments.length === 0
                ? []
                : [renderAttachments(entry.attachment_details)]),
              "",
              entry.body
            ].join("\n")
          )
          const separatorBytes =
            rendered.length === 0 ? 0 : Buffer.byteLength("\n\n---\n\n", "utf8")
          const entryBytes = Buffer.byteLength(bounded.text, "utf8")
          if (
            rendered.length > 0 &&
            renderedBytes + separatorBytes + entryBytes > MAX_THREAD_PAGE_CONTENT_BYTES
          )
            break
          rendered.push(bounded.text)
          pageMessages.push(entry)
          renderedBytes += separatorBytes + entryBytes
          outputTruncated ||= entry.body_truncated || bounded.truncated
        }
        const nextOffset = offset + pageMessages.length
        const nextPageRef = nextOffset < messages.length ? threadPageRef(ref, nextOffset) : null
        const result = [
          rendered.join("\n\n---\n\n"),
          ...(nextPageRef === null ? [] : [`Next page_ref: ${nextPageRef}`])
        ].join("\n\n")
        const subject = messages.at(-1)?.subject ?? "(no subject)"
        const newest =
          [...pageMessages]
            .reverse()
            .find((entry) => passage(unquotedEmail(entry.body)) !== undefined) ??
          pageMessages.at(-1)
        if (newest === undefined)
          throw toolRefusal("Gmail returned an empty thread.", "Invalid Gmail response")
        const source_refs = [
          emailSource({
            use: "read",
            kind: "thread",
            ref: input.thread_ref,
            account: response.account.email,
            threadId: item.id,
            subject: messages[0]?.subject ?? subject,
            from: newest.from,
            body: newest.body,
            receivedAt: newest.received_at
          })
        ]
        return {
          host: { source_refs },
          result,
          preview: `${subject} · messages ${offset + 1}-${nextOffset} of ${messages.length}`,
          data: {
            account_ref: response.account.email,
            thread_ref: input.thread_ref,
            message_count: messages.length,
            page_start: offset,
            page_message_count: pageMessages.length,
            messages: pageMessages.map(({ body: _body, ...summary }) => summary),
            next_page_ref: nextPageRef,
            has_more: nextPageRef !== null,
            output_truncated: outputTruncated,
            source_refs
          }
        }
      }
    })
  ]
}
