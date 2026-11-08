import { Option, Predicate, Schema } from "effect"
import { isHumanMessage } from "@arden-hq/loop"

export { isHumanMessage } from "@arden-hq/loop"

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
  readonly is_meta?: unknown
  readonly automation?: unknown
  readonly interaction?: unknown
}

export const latestHumanText = (messages: ReadonlyArray<ContentEnvelope>): string | undefined => {
  const message = messages.findLast(isHumanMessage)
  return message === undefined ? undefined : authoredText(message.content)
}
