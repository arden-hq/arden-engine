import { ToolExecutionError } from "@arden-hq/loop"
import { publicWebUrl } from "@arden-hq/std/url"
import { Schema } from "effect"

import type { CallEffects } from "../execution/tool-effect.js"
import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { requiredAccountRefDescription } from "./google-accounts.js"
import { GMAIL_API, header, message, rawMessage, validRecipient } from "./google-gmail-mime.js"
import { messageRef, parseMessageRef, threadRef } from "./google-gmail-refs.js"
import { gmailSend } from "./google-gmail-request.js"
import { localMessageId } from "./google-gmail-send.js"
import { googleCall } from "./google-request.js"
import { publicAddress, sendRequest } from "./web-fetch.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { toolRefusal } from "./tool-failure.js"

// `email_unsubscribe`: the sender's own List-Unsubscribe header, used the way
// RFC 8058 and RFC 2369 define: a one-click HTTPS POST, or a mail to the
// sender's mailto address. Arden never opens a web page or follows a link.

const MAX_REDIRECTS = 3
const REQUEST_TIMEOUT_MS = 20_000
const ONE_CLICK_BODY = "List-Unsubscribe=One-Click"

type UnsubscribeMethod =
  | { readonly kind: "one_click"; readonly url: URL }
  | {
      readonly kind: "mailto"
      readonly to: string
      readonly subject: string
      readonly body: string
    }
  | { readonly kind: "web_only"; readonly host: string }
  | { readonly kind: "none" }

const entries = (value: string): ReadonlyArray<string> =>
  [...value.matchAll(/<([^<>]*)>/gu)].map((match) => (match[1] ?? "").trim())

const httpsUrl = (value: string): URL | undefined => {
  const page = publicWebUrl(value)
  return page.kind === "ok" && page.url.protocol === "https:" ? page.url : undefined
}

const mailtoTarget = (
  value: string
): { readonly to: string; readonly subject: string; readonly body: string } | undefined => {
  if (!/^mailto:/iu.test(value)) return undefined
  try {
    const url = new URL(value)
    const to = decodeURIComponent(url.pathname)
    if (!validRecipient(to)) return undefined
    const flat = (text: string | null, fallback: string): string =>
      text === null
        ? fallback
        : text
            .replace(/[\r\n]+/gu, " ")
            .trim()
            .slice(0, 500) || fallback
    return {
      to,
      subject: flat(url.searchParams.get("subject"), "unsubscribe"),
      body: flat(url.searchParams.get("body"), "unsubscribe")
    }
  } catch {
    return undefined
  }
}

/**
 * What the sender's headers allow, best first: a one-click HTTPS POST (only
 * with List-Unsubscribe-Post: List-Unsubscribe=One-Click), else a mailto, else
 * a bare web page Arden leaves alone. Plain http is never used.
 */
const unsubscribeMethod = (
  listUnsubscribe: string | undefined,
  listUnsubscribePost: string | undefined
): UnsubscribeMethod => {
  const targets = entries(listUnsubscribe ?? "")
  const oneClick = /list-unsubscribe\s*=\s*one-click/iu.test(listUnsubscribePost ?? "")
  const url = targets.map(httpsUrl).find((candidate) => candidate !== undefined)
  if (oneClick && url !== undefined) return { kind: "one_click", url }
  const mailto = targets.map(mailtoTarget).find((candidate) => candidate !== undefined)
  if (mailto !== undefined) return { kind: "mailto", ...mailto }
  const web = targets.flatMap((target) => {
    try {
      const parsed = new URL(target)
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? [parsed.hostname] : []
    } catch {
      return []
    }
  })[0]
  return web === undefined ? { kind: "none" } : { kind: "web_only", host: web }
}

const redirectTarget = (location: string, base: URL): URL | undefined => {
  try {
    return httpsUrl(new URL(location, base).href)
  } catch {
    return undefined
  }
}

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status)

const postOneClick = async ({
  url,
  signal: callSignal,
  effects
}: {
  readonly url: URL
  readonly signal: AbortSignal
  readonly effects: CallEffects
}): Promise<{ readonly host: string }> => {
  const signal = AbortSignal.any([callSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  let current = url
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (current.protocol !== "https:") {
      throw toolRefusal("The unsubscribe address must use https.", "Unsubscribe not https")
    }
    const address = await publicAddress(current, signal)
    effects.sent()
    const response = await sendRequest({
      url: current,
      address,
      method: "POST",
      body: ONE_CLICK_BODY,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(ONE_CLICK_BODY)),
        "user-agent": "Arden",
        accept: "*/*",
        "accept-encoding": "identity"
      },
      signal
    })
    response.cancel()
    if (isRedirect(response.status)) {
      const location = response.headers["location"]
      const next = typeof location === "string" ? redirectTarget(location, current) : undefined
      if (next === undefined) {
        effects.failed()
        throw toolRefusal(
          "The sender redirected somewhere that is not a plain https address.",
          "Unsubscribe redirect"
        )
      }
      current = next
      continue
    }
    if (response.status >= 200 && response.status < 300) {
      effects.applied()
      return { host: current.hostname }
    }
    effects.failed()
    throw toolRefusal(
      `The sender's server answered HTTP ${response.status}, so the unsubscribe is not confirmed.`,
      `HTTP ${response.status}`
    )
  }
  effects.failed()
  throw toolRefusal("The sender redirected too many times.", "Too many redirects")
}

const methodLine = (method: UnsubscribeMethod): string => {
  switch (method.kind) {
    case "one_click":
      return `One-click request to ${method.url.hostname}`
    case "mailto":
      return `Email to ${method.to}`
    case "web_only":
    case "none":
      return "None"
  }
}

const refusalFor = (method: UnsubscribeMethod): ToolExecutionError =>
  method.kind === "web_only"
    ? toolRefusal(
        `This sender offers only a web page (${method.host}) to unsubscribe. Arden does not open links from email; the user can open the message and use its unsubscribe link. Nothing was done.`,
        "Web page only"
      )
    : toolRefusal(
        "This message has no List-Unsubscribe header, so Arden cannot unsubscribe from it. Nothing was done.",
        "No unsubscribe header"
      )

export const gmailUnsubscribeTool = ({
  google,
  emails
}: {
  readonly google: GoogleToolConnections
  readonly emails: ReadonlyArray<string>
}): ServerTool => {
  const readHeaders = async (messageReference: string, signal: AbortSignal) => {
    const ref = parseMessageRef(messageReference)
    const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(ref.id)}`)
    url.searchParams.set("format", "metadata")
    for (const name of ["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post"]) {
      url.searchParams.append("metadataHeaders", name)
    }
    const response = await googleCall({
      google,
      service: "gmail",
      url: url.href,
      accountRef: ref.account,
      signal
    })
    const original = message(response.value)
    if (original.id !== ref.id) {
      throw toolRefusal("Gmail returned a different message.", "Invalid Gmail response")
    }
    return {
      account: response.account.email,
      from: header(original.payload, "From") ?? "",
      subject: header(original.payload, "Subject") ?? "(no subject)",
      method: unsubscribeMethod(
        header(original.payload, "List-Unsubscribe"),
        header(original.payload, "List-Unsubscribe-Post")
      )
    }
  }
  return defineServerTool({
    name: "email_unsubscribe",
    description: [
      "Unsubscribe from a mailing list using the message's own List-Unsubscribe header: a one-click HTTPS request, or an email to the sender's mailto address.",
      "If the message offers neither, nothing is done and Arden never opens a web page."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        message_ref: Schema.String.annotate({
          description: requiredAccountRefDescription(
            "gmail",
            "Exact account-qualified message_ref of a message from the sender, returned by email_search or email_thread_read.",
            emails
          )
        }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024))
      })
    ),
    metadata: {
      effect: "external",
      display_name: "Unsubscribe from Email",
      kind: "tool",
      action: "write",
      approval_preview: "Unsubscribe from this sender.",
      source: "gmail",
      changes_state: true,
      target: "reported",
      concurrency_group: "gmail_write",
      destructive: true,
      default_approval: "ask",
      policy_scope: "external",
      permissions: ["email"],
      idempotent: false
    },
    approvalPrompt: async (input, ctx) => {
      const found = await readHeaders(input.message_ref, ctx.signal)
      if (found.method.kind === "web_only" || found.method.kind === "none") {
        throw refusalFor(found.method)
      }
      return {
        preview: `Unsubscribe from ${found.from}`,
        presentation: {
          title: "Unsubscribe from this sender?",
          approve_label: "Unsubscribe",
          fields: [
            { label: "Account", value: found.account },
            { label: "Sender", value: found.from || "(unknown)" },
            { label: "Message", value: found.subject },
            { label: "Method", value: methodLine(found.method) }
          ]
        }
      }
    },
    execute: async (input, ctx, effects) => {
      const found = await readHeaders(input.message_ref, ctx.signal)
      const { method } = found
      if (method.kind === "one_click") {
        await effects.target({
          source: "gmail",
          objectId: `list-unsubscribe:${sha256Hex(method.url.href)}`,
          title: found.from || found.subject
        })
        const done = await postOneClick({ url: method.url, signal: ctx.signal, effects })
        return {
          result: `Unsubscribed from ${found.from} through a one-click request to ${done.host}.`,
          preview: `Unsubscribed (${done.host})`,
          data: { account_ref: found.account, method: "one_click", host: done.host }
        }
      }
      if (method.kind === "mailto") {
        const sent = await gmailSend({
          google,
          account: found.account,
          subject: method.subject,
          body: {
            raw: rawMessage({
              sender: found.account,
              to: [method.to],
              subject: method.subject,
              body: method.body,
              html: false,
              messageId: localMessageId(ctx.toolCallId)
            })
          },
          signal: ctx.signal,
          effects
        })
        return {
          result: `Unsubscribed from ${found.from} by emailing ${method.to}.`,
          preview: `Emailed ${method.to}`,
          data: {
            account_ref: found.account,
            method: "mailto",
            recipient: method.to,
            message_ref: messageRef(found.account, sent.id),
            thread_ref: threadRef(found.account, sent.threadId)
          }
        }
      }
      throw refusalFor(method)
    }
  })
}
