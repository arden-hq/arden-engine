import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { emailSource } from "./google-gmail-source.js"
import { Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import {
  attachmentMetadata,
  GMAIL_API,
  header,
  message,
  messageDate,
  payloadText
} from "./google-gmail-mime.js"
import { decodePageRef, messageRef, parseMessageRef, threadRef } from "./google-gmail-refs.js"
import { googleCall } from "./google-request.js"
import { encodeOpaque } from "../lib/opaque-ref.js"
import { toolFault, toolRefusal } from "./tool-failure.js"
import {
  ReadParametersSchema,
  messageList,
  renderAttachments,
  searchParametersSchema,
  searchSnippet,
  settledInBatches
} from "./google-gmail-read-support.js"
import { makeEmailThreadReadTool, makeEmailThreadSearchTool } from "./google-gmail-thread-tools.js"

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
      summary: "Searches your email.",
      discovery: { group: "email" },
      description: [
        "Search individual Gmail messages with Gmail query syntax; the default query is the last 7 days.",
        "Returns message_ref values for email_read, email_reply, email_forward, email_draft, email_attachment_save and email_unsubscribe, and thread_ref values for email_thread_read, email_update and email_trash.",
        "Use email_thread_search for one result per conversation."
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
    makeEmailThreadSearchTool({ google, emails }),
    defineServerTool({
      name: "email_read",
      summary: "Reads an email.",
      discovery: { group: "email" },
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
    makeEmailThreadReadTool({ google })
  ]
}
