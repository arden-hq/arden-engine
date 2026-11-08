import { clipLine } from "@arden-hq/std/text"
import { countOf, formatBytes } from "@arden-hq/std/count"
import { defineServerTool, type ServerTool } from "./define.js"
import { readHtml } from "./html-content.js"
import { ToolExecutionError } from "@arden-hq/loop"
import { publicWebUrl, type WebUrlIssue } from "@arden-hq/std/url"
import { retryableStatus } from "@arden-hq/std/retry"
import { Effect, Schema } from "effect"
import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP, type LookupFunction } from "node:net"

import { bodyFields } from "./code-mode-result.js"
import { passage } from "./source-passage.js"
import { selectText, textSelectFields } from "./text-select.js"
import { textBefore } from "../lib/text.js"
import { toolFault, toolRefusal } from "./tool-failure.js"

const DEFAULT_TIMEOUT_SECONDS = 20
const MAX_TIMEOUT_SECONDS = 60
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5

const FormatSchema = Schema.Literals(["markdown", "text", "html"] as const).pipe(
  Schema.withDecodingDefault(Effect.succeed("markdown" as const))
)

const ParametersSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
    description: "Complete public HTTP(S) URL to fetch."
  }),
  format: FormatSchema.pipe(
    Schema.annotateEncoded({
      description: "Output format. Defaults to readable markdown."
    })
  ),
  timeout_seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS }))
    .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMEOUT_SECONDS)))
    .pipe(
      Schema.annotateEncoded({
        description: `Whole-request timeout in seconds, from 1 to ${MAX_TIMEOUT_SECONDS}.`
      })
    ),
  ...textSelectFields
})

export interface WebFetchAddress {
  readonly address: string
  readonly family: 4 | 6
}

interface WebFetchResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: AsyncIterable<Uint8Array>
  readonly cancel: () => void
}

interface WebFetchRequest {
  readonly url: URL
  readonly address: WebFetchAddress
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly method?: "GET" | "POST"
  readonly body?: string
}

export interface FetchedPage {
  readonly url: URL
  readonly status: number
  readonly contentType: string
  readonly bytes: number
  readonly content: string
}

const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  blockedIpv4.addSubnet(network, prefix, "ipv4")

const publicIpv6 = new BlockList()
publicIpv6.addSubnet("2000::", 3, "ipv6")
const blockedIpv6 = new BlockList()
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
] as const)
  blockedIpv6.addSubnet(network, prefix, "ipv6")

const lookupHost = async (
  hostname: string,
  signal: AbortSignal
): Promise<ReadonlyArray<WebFetchAddress>> =>
  raceAbort(
    dnsLookup(hostname, { all: true, verbatim: true }).then((addresses) =>
      addresses.flatMap((address): ReadonlyArray<WebFetchAddress> =>
        address.family === 4 || address.family === 6
          ? [{ address: address.address, family: address.family }]
          : []
      )
    ),
    signal
  )

export const sendRequest = ({
  url,
  address,
  headers,
  signal,
  method = "GET",
  body
}: WebFetchRequest): Promise<WebFetchResponse> =>
  new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, options, callback): void => {
      if (options.all === true) {
        callback(null, [address])
        return
      }
      callback(null, address.address, address.family)
    }
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers,
        lookup,
        agent: false,
        maxHeaderSize: 32 * 1024,
        signal
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          cancel: () => response.destroy()
        })
    )
    request.once("error", reject)
    request.end(body)
  })

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const settle = (effect: () => void): void => {
      signal.removeEventListener("abort", onAbort)
      effect()
    }
    const onAbort = (): void => settle(() => reject(signal.reason))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => settle(() => resolve(value)),
      (cause) => settle(() => reject(cause))
    )
  })

const canonicalUrl = (raw: string, base?: URL): URL => {
  if (raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw toolRefusal(
      "web_fetch requires a URL without whitespace padding or control characters.",
      "Invalid URL"
    )
  }
  const page = publicWebUrl(raw, base)
  if (page.kind === "ok") return page.url
  const [message, preview] = URL_REFUSAL[page.issue]
  throw toolRefusal(message, preview)
}

const URL_REFUSAL: Record<WebUrlIssue, readonly [message: string, preview: string]> = {
  invalid: ["web_fetch requires a complete, valid HTTP(S) URL.", "Invalid URL"],
  scheme: ["web_fetch accepts only HTTP(S) URLs.", "Unsupported URL"],
  credentials: ["web_fetch does not accept URLs containing credentials.", "Credential URL blocked"],
  too_long: ["web_fetch URLs cannot exceed 4096 characters.", "URL too long"]
}

const unbracketedHostname = (url: URL): string =>
  url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname

const isLocalHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "")
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  )
}

const isPublicAddress = (address: WebFetchAddress): boolean => {
  if (address.family === 4) return !blockedIpv4.check(address.address, "ipv4")
  return publicIpv6.check(address.address, "ipv6") && !blockedIpv6.check(address.address, "ipv6")
}

const literalAddress = (hostname: string): WebFetchAddress | undefined => {
  const family = isIP(hostname)
  if (family === 4) return { address: hostname, family: 4 }
  if (family === 6) return { address: hostname, family: 6 }
  return undefined
}

export const publicAddress = async (url: URL, signal: AbortSignal): Promise<WebFetchAddress> => {
  const hostname = unbracketedHostname(url)
  if (isLocalHostname(hostname)) {
    throw toolRefusal(
      "web_fetch cannot access local or private network hosts.",
      "Private host blocked"
    )
  }
  const literal = literalAddress(hostname)
  const addresses = literal === undefined ? await lookupHost(hostname, signal) : [literal]
  const [first] = addresses
  if (first === undefined) {
    throw toolFault(`Could not resolve ${hostname}.`, "Host not found")
  }
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw toolRefusal(
      "web_fetch cannot access local, private, reserved, or mixed public/private hosts.",
      "Private address blocked"
    )
  }
  return first
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

const accepts = (format: typeof FormatSchema.Type): string => {
  switch (format) {
    case "markdown":
      return "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/json;q=0.7"
    case "text":
      return "text/plain, text/markdown;q=0.9, text/html;q=0.8, application/json;q=0.7"
    case "html":
      return "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8"
  }
}

const requestHeaders = (format: typeof FormatSchema.Type): Readonly<Record<string, string>> => ({
  "user-agent": "Arden web_fetch",
  accept: accepts(format),
  "accept-language": "en-US,en;q=0.8",
  "accept-encoding": "identity"
})

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308

const isReadableContentType = (mime: string): boolean =>
  (mime.startsWith("text/") && mime !== "text/event-stream") ||
  mime === "application/json" ||
  mime === "application/ld+json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime === "application/xhtml+xml" ||
  mime.endsWith("+xml")

const readBody = async (response: WebFetchResponse): Promise<Buffer> => {
  const length = Number(header(response.headers, "content-length"))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    response.cancel()
    throw toolRefusal(
      `Web response exceeds the ${formatBytes(MAX_RESPONSE_BYTES)} limit.`,
      "Response too large"
    )
  }
  const chunks: Array<Buffer> = []
  let bytes = 0
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        throw toolRefusal(
          `Web response exceeds the ${formatBytes(MAX_RESPONSE_BYTES)} limit.`,
          "Response too large"
        )
      }
      chunks.push(Buffer.from(chunk))
    }
  } catch (cause) {
    response.cancel()
    throw cause
  }
  return Buffer.concat(chunks, bytes)
}

const decodeBody = (body: Buffer, contentType: string): string => {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(contentType)?.[1] ?? "utf-8"
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    throw toolRefusal(`Unsupported response charset: ${charset}.`, "Unsupported charset")
  }
}

export const fetchPage = async (
  requested: URL,
  format: typeof FormatSchema.Type,
  signal: AbortSignal
): Promise<FetchedPage> => {
  let current = requested
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const address = await publicAddress(current, signal)
    const response = await sendRequest({
      url: current,
      address,
      headers: requestHeaders(format),
      signal
    })
    if (isRedirect(response.status)) {
      response.cancel()
      const location = header(response.headers, "location")
      if (location === undefined || location.length === 0) {
        throw toolRefusal(
          `HTTP ${response.status} did not include a redirect URL.`,
          "Invalid redirect"
        )
      }
      if (redirects === MAX_REDIRECTS) {
        throw toolRefusal(`Web page exceeded ${MAX_REDIRECTS} redirects.`, "Too many redirects")
      }
      current = canonicalUrl(location, current)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      response.cancel()
      const failure = retryableStatus(response.status) ? toolFault : toolRefusal
      throw failure(`Web server returned HTTP ${response.status}.`, `HTTP ${response.status}`)
    }
    const contentEncoding = header(response.headers, "content-encoding")?.trim().toLowerCase()
    if (contentEncoding !== undefined && contentEncoding !== "identity") {
      response.cancel()
      throw toolRefusal(
        `Web server ignored the identity encoding request (${contentEncoding}).`,
        "Unsupported encoding"
      )
    }
    const contentType = header(response.headers, "content-type") ?? ""
    const mime = textBefore(contentType, ";").trim().toLowerCase()
    if (!isReadableContentType(mime)) {
      response.cancel()
      throw toolRefusal(
        `web_fetch reads text pages; received ${mime || "no content type"}.`,
        "Unsupported content type"
      )
    }
    const body = await readBody(response)
    return {
      url: current,
      status: response.status,
      contentType,
      bytes: body.byteLength,
      content: decodeBody(body, contentType)
    }
  }
  throw toolRefusal(`Web page exceeded ${MAX_REDIRECTS} redirects.`, "Too many redirects")
}

const boundedTitle = (title: string): string => clipLine(title, 256)

const formatContent = (
  page: FetchedPage,
  format: typeof FormatSchema.Type
): {
  readonly content: string
  readonly title: string | undefined
  readonly body: string
  readonly json: boolean
} => {
  const mime = textBefore(page.contentType, ";").trim().toLowerCase()
  const rendered =
    mime === "text/html" || mime === "application/xhtml+xml"
      ? readHtml(page.content, { base: page.url, format })
      : { content: page.content.trim(), title: undefined }
  return {
    content: rendered.content || "(page contained no readable text)",
    title: rendered.title,
    body: rendered.content,
    json: mime === "application/json" || mime.endsWith("+json")
  }
}

const makeWebFetchTool = (): ServerTool =>
  defineServerTool({
    name: "web_fetch",
    description: [
      "Fetch one public HTTP(S) page as readable markdown, text, or HTML.",
      "Redirects are followed only after validating every destination.",
      "In markdown, the page's images come back as ![alt](url) lines with absolute addresses, its lead image first.",
      "For a large page or feed, set grep (a regular expression) to get only the matching lines with grep_context lines around them."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Web fetch",
      background: true,
      kind: "web",
      action: "read",
      approval_preview: "Fetch a public web page.",
      source: "_web",
      changes_state: false,
      concurrency_group: "web",
      destructive: null,
      policy_scope: "external",
      permissions: ["web"],
      open_world: true,
      idempotent: true
    },
    execute: async (input, ctx) => {
      const requested = canonicalUrl(input.url)
      const timeout = new AbortController()
      const timer = setTimeout(
        () => timeout.abort(new Error("web_fetch timeout")),
        input.timeout_seconds * 1_000
      )
      const signal = AbortSignal.any([ctx.signal, timeout.signal])
      try {
        const page = await fetchPage(requested, input.format, signal)
        const { content, body, json, title: possibleTitle } = formatContent(page, input.format)
        ctx.run.codeMode.scriptFields(ctx.toolCallId, () =>
          bodyFields(body, { declaredJson: json })
        )
        const title = boundedTitle(possibleTitle ?? page.url.toString())
        const source_refs = [
          {
            provider: "web",
            kind: "page",
            ref: page.url.toString(),
            title,
            url: page.url.toString(),
            mime_type: page.contentType,
            use: "read" as const,
            href: page.url.toString(),
            ...(passage(content) === undefined ? {} : { excerpt: passage(content) })
          }
        ]
        const selected = selectText(content, input)
        return {
          result: selected.text,
          preview:
            input.grep === undefined
              ? `Fetched ${title}`
              : `Fetched ${title}: ${countOf(selected.matches, "matching line")}`,
          data: {
            requested_url: requested.toString(),
            final_url: page.url.toString(),
            status: page.status,
            content_type: page.contentType,
            bytes: page.bytes,
            truncated: false,
            ...(input.grep === undefined ? {} : { matches: selected.matches }),
            source_refs
          },
          host: { source_refs }
        }
      } catch (cause) {
        if (cause instanceof ToolExecutionError) throw cause
        if (timeout.signal.aborted && !ctx.signal.aborted) {
          throw toolFault(
            `web_fetch timed out after ${input.timeout_seconds} seconds. Retry or use a faster source.`,
            "Fetch timed out"
          )
        }
        if (ctx.signal.aborted) {
          throw toolFault("web_fetch was cancelled.", "Fetch cancelled")
        }
        throw toolFault(
          `Could not fetch ${requested.hostname}. Check the URL or retry.`,
          "Fetch failed"
        )
      } finally {
        clearTimeout(timer)
      }
    }
  })

export const webFetchTools = Effect.sync(() => [makeWebFetchTool()])
