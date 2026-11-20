import { isWrittenByPerson } from "./model.js"
import { Option, Predicate, Schema } from "effect"
import { answerBlockText } from "@arden-hq/answer-ui"
import { answerBlockTitle, replaceAnswerBlocks } from "@arden-hq/protocol/chat"
import { cutText } from "@arden-hq/std/text"
import type { StoredMessageEnvelope } from "./model.js"
import { ownerText } from "./owner-words.js"

const ContentPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("context"),
    content_type: Schema.String,
    content: Schema.optionalKey(Schema.NullOr(Schema.String)),
    metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
  }),
  Schema.Struct({
    type: Schema.Literals(["image", "audio"] as const),
    media_type: Schema.String,
    data: Schema.String
  })
])

export type ContentPart = (typeof ContentPartSchema)["Type"]
const decodeContentPart = Schema.decodeUnknownOption(ContentPartSchema)

const decodePart = (part: unknown) =>
  decodeContentPart(
    Predicate.isObject(part) && !("type" in part) && "content_type" in part
      ? { ...part, type: "context" }
      : part
  )

export const contentParts = (content: unknown): ReadonlyArray<ContentPart> => {
  if (Predicate.isString(content)) return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    const decoded = decodePart(part)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
}

export const authoredText = (content: unknown): string =>
  contentParts(content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

export const evidenceText = (content: unknown): string =>
  contentParts(content)
    .flatMap((part) => {
      switch (part.type) {
        case "text":
          return [part.text]
        case "image":
          return ["[image]"]
        case "audio":
          return ["[audio]"]
        case "context": {
          const source = [part.content_type, part.metadata?.tool_name, part.metadata?.tool_call_id]
            .filter((value) => value !== undefined)
            .join(" · ")
          return [`[${source}]${part.content ? `\n${part.content}` : ""}`]
        }
      }
    })
    .join("\n")

export interface ContentEnvelope {
  readonly role: string
  readonly content?: unknown
  readonly question_answer?: unknown
}

export const latestHumanText = (messages: ReadonlyArray<ContentEnvelope>): string | undefined => {
  const message = messages.findLast(isWrittenByPerson)
  return message === undefined ? undefined : authoredText(message.content)
}

const SUMMARY_CHARS = 300

const summarizeAnswerBlock = (body: string): string => {
  const lines = answerBlockText(body)
    .split("\n")
    .map((line) => line.trim())
  const heading = lines.find((line) => line.startsWith("## "))?.slice(3)
  const title = heading ?? answerBlockTitle(body)
  const summary = cutText(
    lines
      .filter((line) => line.length > 0 && !line.startsWith("## ") && !TABLE_RULE.test(line))
      .map(plainLine)
      .filter((line) => line.length > 0)
      .join("; "),
    SUMMARY_CHARS
  )
  const label = title === undefined ? "interactive block" : `interactive block: ${title}`
  return summary.length === 0 ? `[${label}]` : `[${label} — ${summary}]`
}

const COMPACT_CACHE_SIZE = 256
const compacted = new Map<string, string>()

export const compactAnswerBlock = (body: string): string => {
  const known = compacted.get(body)
  if (known !== undefined) return known
  const line = summarizeAnswerBlock(body)
  if (compacted.size >= COMPACT_CACHE_SIZE) {
    const oldest = compacted.keys().next()
    if (oldest.done !== true) compacted.delete(oldest.value)
  }
  compacted.set(body, line)
  return line
}

export const compactAnswerBlocks = (markdown: string): string =>
  replaceAnswerBlocks(markdown, compactAnswerBlock)

const TABLE_RULE = /^\|(?:\s*-+\s*\|)+$/

const plainLine = (line: string): string =>
  line.startsWith("|")
    ? line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" ")
    : line.replace(/\*\*(.+?)\*\*/g, "$1")

/**
 * The text Memory Capture reads of a message, or null when it reads none. An answer to Arden's
 * question reads as what the owner said, with Arden's prompt marked as Arden's.
 */
export const capturedText = (message: StoredMessageEnvelope): string | null => {
  if (message.superseded === true) return null
  const text = (
    message.question_answer === undefined
      ? compactAnswerBlocks(authoredText(message.content))
      : ownerText(message)
  ).trim()
  return text.length === 0 ? null : text
}
