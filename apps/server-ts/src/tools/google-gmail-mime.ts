import { cutBytes } from "@arden-hq/std/text"
import { Effect, Schema } from "effect"

import { decodeGoogle } from "./google-request.js"
import { readHtml } from "./html-content.js"
import { iso } from "../runtime/clock.js"
import { toolRefusal } from "./tool-failure.js"

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
export const MAX_BODY_CHARS = 200_000
export const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1_024 * 1_024
const MAX_EMAIL_MESSAGE_BYTES = 35 * 1_024 * 1_024
const MAX_THREAD_MESSAGE_BYTES = 16 * 1_024
const MAX_THREAD_RENDERED_MESSAGE_BYTES = 24 * 1_024

interface GmailPayload {
  readonly mimeType?: string
  readonly filename?: string
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly body?: {
    readonly data?: string
    readonly attachmentId?: string
    readonly size?: number
  }
  readonly parts?: ReadonlyArray<GmailPayload>
}

const GmailPayloadSchema: Schema.Codec<GmailPayload> = Schema.Struct({
  mimeType: Schema.optionalKey(Schema.String),
  filename: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }))
  ),
  body: Schema.optionalKey(
    Schema.Struct({
      data: Schema.optionalKey(Schema.String),
      attachmentId: Schema.optionalKey(Schema.String),
      size: Schema.optionalKey(Schema.Number)
    })
  ),
  parts: Schema.optionalKey(Schema.Array(Schema.suspend(() => GmailPayloadSchema)))
})

const GmailMessageSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  internalDate: Schema.optionalKey(Schema.String),
  snippet: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(GmailPayloadSchema)
})
type GmailMessage = typeof GmailMessageSchema.Type

export const message = decodeGoogle(GmailMessageSchema, { service: "gmail", label: "message" })

export const thread = decodeGoogle(
  Schema.Struct({
    id: Schema.NonEmptyString,
    snippet: Schema.optionalKey(Schema.String),
    messages: Schema.Array(GmailMessageSchema).pipe(Schema.withDecodingDefault(Effect.succeed([])))
  }),
  { service: "gmail", label: "thread" }
)

export const header = (payload: GmailPayload | undefined, name: string): string | undefined =>
  payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value

const decodeBody = (value: string): string => {
  try {
    return Buffer.from(value, "base64url").toString("utf8")
  } catch {
    throw toolRefusal("Gmail returned invalid message content.", "Invalid Gmail response")
  }
}

export const payloadText = (
  payload: GmailPayload | undefined
): {
  readonly text: string
  readonly attachments: ReadonlyArray<string>
} => {
  if (payload === undefined) return { text: "", attachments: [] }
  const attachments: string[] = []
  let plain = ""
  let html = ""
  const visit = (part: GmailPayload): void => {
    if (part.filename) attachments.push(part.filename)
    const data = part.body?.data
    if (data !== undefined && !part.filename) {
      const decoded = decodeBody(data)
      if (part.mimeType === "text/plain") plain += decoded
      if (part.mimeType === "text/html") html += decoded
      if (part.mimeType === undefined && plain === "") plain += decoded
    }
    for (const child of part.parts ?? []) visit(child)
  }
  visit(payload)
  return {
    text: (plain.trim() || readHtml(html, { format: "text" }).content).slice(0, MAX_BODY_CHARS),
    attachments
  }
}

export interface AttachmentPart {
  readonly index: number
  readonly filename: string
  readonly mimeType: string
  readonly size: number | undefined
  /** Gmail serves large parts by id; small ones carry `data` (base64url) inline. */
  readonly attachmentId: string | undefined
  readonly data: string | undefined
}

export const attachmentParts = (
  payload: GmailPayload | undefined
): ReadonlyArray<AttachmentPart> => {
  const found: Array<AttachmentPart> = []
  const visit = (part: GmailPayload): void => {
    if (part.filename) {
      found.push({
        index: found.length + 1,
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size,
        attachmentId: part.body?.attachmentId,
        data: part.body?.data
      })
    }
    for (const child of part.parts ?? []) visit(child)
  }
  if (payload !== undefined) visit(payload)
  return found
}

export const attachmentMetadata = (
  payload: GmailPayload | undefined
): ReadonlyArray<{
  readonly index: number
  readonly filename: string
  readonly mime_type: string
  readonly byte_length: number | null
  readonly attachment_id: string | null
}> =>
  attachmentParts(payload).map((part) => ({
    index: part.index,
    filename: part.filename,
    mime_type: part.mimeType,
    byte_length: part.size ?? null,
    attachment_id: part.attachmentId ?? null
  }))

const encodedWords = (value: string): ReadonlyArray<string> => {
  const chunks: string[] = []
  let current = ""
  for (const character of value) {
    const candidate = `${current}${character}`
    if (current !== "" && Buffer.byteLength(candidate, "utf8") > 45) {
      chunks.push(current)
      current = character
    } else {
      current = candidate
    }
  }
  if (current !== "") chunks.push(current)
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`)
}

const foldTokenHeader = (name: string, tokens: ReadonlyArray<string>): string => {
  if (tokens.length === 0) return `${name}:`
  const lines: string[] = []
  let current = `${name}: ${tokens[0]}`
  for (const token of tokens.slice(1)) {
    if (current.length + token.length + 1 <= 78) current = `${current} ${token}`
    else {
      lines.push(current)
      current = ` ${token}`
    }
  }
  lines.push(current)
  return lines.join("\r\n")
}

const foldAddressHeader = (name: string, addresses: ReadonlyArray<string>): string => {
  const first = addresses[0]
  if (first === undefined) throw toolRefusal(`${name} requires a recipient.`, "Invalid recipient")
  const lines: string[] = []
  let current = `${name}: ${first}`
  for (const address of addresses.slice(1)) {
    if (current.length + address.length + 2 <= 78) current = `${current}, ${address}`
    else {
      lines.push(`${current},`)
      current = ` ${address}`
    }
  }
  lines.push(current)
  return lines.join("\r\n")
}

export interface MessageAttachment {
  readonly filename: string
  readonly mimeType: string
  readonly bytes: Uint8Array
}

export const rawMessage = ({
  sender,
  to,
  cc,
  subject,
  body,
  html,
  messageId,
  inReplyTo,
  references,
  attachments = []
}: {
  readonly sender: string
  readonly to: ReadonlyArray<string>
  readonly cc?: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  readonly html: boolean
  readonly messageId: string
  readonly inReplyTo?: string
  readonly references?: string
  readonly attachments?: ReadonlyArray<MessageAttachment>
}): string => {
  if (
    attachments.reduce((size, file) => size + file.bytes.byteLength, 0) > MAX_EMAIL_ATTACHMENT_BYTES
  ) {
    throw toolRefusal(
      "The attachments exceed Gmail's 25 MiB total limit. Send fewer files or share a Drive link.",
      "Attachments too large"
    )
  }
  const headers = [
    `From: ${sender}`,
    foldAddressHeader("To", to),
    ...(cc === undefined || cc.length === 0 ? [] : [foldAddressHeader("Cc", cc)]),
    foldTokenHeader("Subject", encodedWords(subject)),
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    ...(inReplyTo === undefined ? [] : [`In-Reply-To: ${inReplyTo}`]),
    ...(references === undefined ? [] : [foldTokenHeader("References", references.split(" "))])
  ]
  const textHeaders = [
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: 8bit"
  ]
  let boundary = `arden-${messageId.replace(/[^A-Za-z0-9]/gu, "").slice(0, 32)}`
  while (body.includes(boundary)) boundary += "x"
  const parts = [
    [...textHeaders, "", body].join("\r\n"),
    ...attachments.map((file) => {
      const type = /^[\w.+-]+\/[\w.+-]+$/u.test(file.mimeType)
        ? file.mimeType
        : "application/octet-stream"
      return [
        `Content-Type: ${type}; ${parameterValue("name", file.filename)}`,
        `Content-Disposition: attachment; ${parameterValue("filename", file.filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(file.bytes)
      ].join("\r\n")
    })
  ]
  const contents =
    attachments.length === 0
      ? `${[...headers, ...textHeaders].join("\r\n")}\r\n\r\n${body}`
      : `${[...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`].join("\r\n")}\r\n\r\n${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("")}--${boundary}--\r\n`
  const bytes = Buffer.from(contents, "utf8")
  if (bytes.byteLength > MAX_EMAIL_MESSAGE_BYTES) {
    throw toolRefusal(
      "The encoded email exceeds Gmail's 35 MiB message limit. Send fewer files or share a Drive link.",
      "Email too large"
    )
  }
  return bytes.toString("base64url")
}

const oneLine = (value: string): string => value.replace(/[\r\n]+/gu, " ").trim()

/** Preserve Unicode filenames with RFC 2231 parameters and an ASCII fallback. */
const parameterValue = (name: string, value: string): string => {
  const clean = oneLine(value)
  const fallback = clean.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "\\$&")
  if (/^[\x20-\x7e]*$/u.test(clean)) return `${name}="${fallback}"`
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `${name}="${fallback}"; ${name}*=UTF-8''${encoded}`
}

const base64Lines = (bytes: Uint8Array): string =>
  (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/gu) ?? []
  ).join("\r\n")

export const rawForward = ({
  sender,
  to,
  cc,
  subject,
  note,
  original,
  attachments,
  messageId
}: {
  readonly sender: string
  readonly to: ReadonlyArray<string>
  readonly cc: ReadonlyArray<string>
  readonly subject: string
  readonly note: string
  readonly original: {
    readonly from: string
    readonly date: string
    readonly subject: string
    readonly to: string
    readonly text: string
  }
  readonly attachments: ReadonlyArray<MessageAttachment>
  readonly messageId: string
}): string => {
  const quoted = [
    "---------- Forwarded message ---------",
    `From: ${oneLine(original.from)}`,
    `Date: ${oneLine(original.date)}`,
    `Subject: ${oneLine(original.subject)}`,
    `To: ${oneLine(original.to)}`,
    "",
    original.text.replace(/\r?\n/gu, "\r\n")
  ].join("\r\n")
  const text = note.trim() === "" ? quoted : `${note.replace(/\r?\n/gu, "\r\n")}\r\n\r\n${quoted}`
  return rawMessage({
    sender,
    to,
    cc,
    subject: oneLine(subject),
    body: text,
    html: false,
    attachments,
    messageId
  })
}

export const validRecipient = (value: string): boolean =>
  value === value.trim() && /^[^@\s]+@[^@\s]+$/u.test(value) && !/[\r\n]/u.test(value)

const mailboxAddress = (value: string): string | undefined => {
  const trimmed = value.trim()
  if (validRecipient(trimmed)) return trimmed
  const bracketed = trimmed.match(/<([^<>]+)>\s*$/u)?.[1]
  return bracketed !== undefined && validRecipient(bracketed) ? bracketed : undefined
}

export const mailboxAddresses = (value: string | undefined): ReadonlyArray<string> | undefined => {
  if (value === undefined || value.trim() === "") return []
  const tokens: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  let angleDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quoted) {
      escaped = true
      continue
    }
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && character === "<") angleDepth += 1
    if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1)
    if (!quoted && angleDepth === 0 && character === ",") {
      tokens.push(value.slice(start, index))
      start = index + 1
    }
  }
  if (quoted || angleDepth !== 0) return undefined
  tokens.push(value.slice(start))

  const addresses: string[] = []
  for (const raw of tokens) {
    const token = raw
      .trim()
      .replace(/;$/u, "")
      .replace(/^[^<@,:]+:\s*/u, "")
    if (token === "") continue
    const address = mailboxAddress(token)
    if (address === undefined) return undefined
    addresses.push(address)
  }
  return addresses
}

export const uniqueAddresses = (
  values: ReadonlyArray<string>,
  excluded: ReadonlySet<string> = new Set()
): ReadonlyArray<string> => {
  const seen = new Set([...excluded].map((value) => value.toLowerCase()))
  const result: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

const unfoldHeader = (value: string): string | null => {
  const unfolded = value.replace(/\r?\n[\t ]+/gu, " ").trim()
  return /[\r\n]/u.test(unfolded) ? null : unfolded
}

export const normalizeMessageId = (value: string): string | null => {
  const unfolded = unfoldHeader(value)
  return unfolded !== null && unfolded.length <= 900 && /^<[^<>\s@]+@[^<>\s@]+>$/u.test(unfolded)
    ? unfolded
    : null
}

export const normalizeReferences = (value: string): string | null => {
  const unfolded = unfoldHeader(value)
  if (unfolded === null) return null
  if (unfolded === "") return ""
  const references = unfolded.split(/\s+/u)
  return references.every((reference) => normalizeMessageId(reference) === reference)
    ? references.join(" ")
    : null
}

export const messageDate = (value: string | undefined): string | null => {
  if (value === undefined) return null
  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? iso(timestamp) : null
}

export const chronologicalMessages = (
  messages: ReadonlyArray<GmailMessage>
): ReadonlyArray<GmailMessage> =>
  messages
    .map((item, index) => ({ item, index, timestamp: Number(item.internalDate) }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : Number.POSITIVE_INFINITY
      const rightTime = Number.isFinite(right.timestamp)
        ? right.timestamp
        : Number.POSITIVE_INFINITY
      return leftTime - rightTime || left.index - right.index
    })
    .map(({ item }) => item)

export const boundedThreadBody = (
  value: string
): { readonly text: string; readonly truncated: boolean } => {
  if (Buffer.byteLength(value, "utf8") <= MAX_THREAD_MESSAGE_BYTES) {
    return { text: value, truncated: false }
  }
  return {
    text: cutBytes(value, MAX_THREAD_MESSAGE_BYTES, {
      suffix: "\n\n[Message body truncated by Arden.]"
    }),
    truncated: true
  }
}

export const boundedRenderedMessage = (
  value: string
): { readonly text: string; readonly truncated: boolean } => {
  if (Buffer.byteLength(value, "utf8") <= MAX_THREAD_RENDERED_MESSAGE_BYTES) {
    return { text: value, truncated: false }
  }
  return {
    text: cutBytes(value, MAX_THREAD_RENDERED_MESSAGE_BYTES, {
      suffix: "\n\n[Message output truncated by Arden.]"
    }),
    truncated: true
  }
}
