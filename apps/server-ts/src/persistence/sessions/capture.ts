import { Option, Schema } from "effect"
import type { StoredMessageEnvelope } from "../transcript/model.js"

export const CaptureForwardSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  session_ref: Schema.NonEmptyString,
  name: Schema.String,
  client_id: Schema.NonEmptyString
})

export type CaptureForward = (typeof CaptureForwardSchema)["Type"]

const StoredCaptureSchema = Schema.Struct({
  at: Schema.String,
  forwarded: Schema.optionalKey(CaptureForwardSchema)
})

export type StoredCapture = (typeof StoredCaptureSchema)["Type"]

export const readCapture = (
  metadata: Readonly<Record<string, unknown>>
): StoredCapture | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(StoredCaptureSchema)(metadata["capture"]))

const ImagePartSchema = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: Schema.Literals(["image/png", "image/jpeg"] as const),
  data: Schema.NonEmptyString
})
const TextPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const HandedContentSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([ImagePartSchema, TextPartSchema]))
])

export interface HandedCapture {
  readonly note: string
  readonly images: ReadonlyArray<{
    readonly mediaType: "image/png" | "image/jpeg"
    readonly data: string
  }>
}

export const handedCapture = (
  messages: ReadonlyArray<StoredMessageEnvelope>
): HandedCapture | undefined => {
  const first = messages.find((message) => message.role === "user" && message["is_meta"] !== true)
  if (first === undefined) return undefined
  const content = Schema.decodeUnknownOption(HandedContentSchema)(first["content"])
  if (Option.isNone(content)) return undefined
  if (typeof content.value === "string") return { note: content.value, images: [] }
  const parts = content.value
  return {
    note: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    images: parts.flatMap((part) =>
      part.type === "image" ? [{ mediaType: part.media_type, data: part.data }] : []
    )
  }
}
