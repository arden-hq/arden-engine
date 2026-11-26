import { isImageMediaType } from "@arden-hq/std/message-vocabulary"
import { CONTENT_BLOCK_TYPE } from "@arden-hq/loop"
import type { ChatImageInput } from "@arden-hq/protocol/chat"
import { contentParts } from "./content.js"

export interface UserContent {
  readonly text: string
  readonly images: ReadonlyArray<ChatImageInput>
}

const isMediaType = (value: unknown): value is ChatImageInput["mediaType"] =>
  isImageMediaType(value)

export const userContent = (content: unknown): UserContent => {
  if (typeof content === "string") return { text: content.trim(), images: [] }
  if (!Array.isArray(content)) return { text: "", images: [] }
  const text: Array<string> = []
  const images: Array<ChatImageInput> = []
  for (const part of contentParts(content)) {
    if (part["type"] === CONTENT_BLOCK_TYPE.text && typeof part["text"] === "string")
      text.push(part["text"])
    if (
      part["type"] === CONTENT_BLOCK_TYPE.image &&
      isMediaType(part["media_type"]) &&
      typeof part["data"] === "string"
    )
      images.push({ mediaType: part["media_type"], data: part["data"] })
  }
  return { text: text.join("\n").trim(), images }
}
