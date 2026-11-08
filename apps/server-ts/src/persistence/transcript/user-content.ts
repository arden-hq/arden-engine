import type { ChatImageInput } from "@arden-hq/protocol/chat"
import { contentParts } from "./content.js"

export interface UserContent {
  readonly text: string
  readonly images: ReadonlyArray<ChatImageInput>
}

const isMediaType = (value: unknown): value is ChatImageInput["mediaType"] =>
  value === "image/png" || value === "image/jpeg"

export const userContent = (content: unknown): UserContent => {
  if (typeof content === "string") return { text: content.trim(), images: [] }
  if (!Array.isArray(content)) return { text: "", images: [] }
  const text: Array<string> = []
  const images: Array<ChatImageInput> = []
  for (const part of contentParts(content)) {
    if (part["type"] === "text" && typeof part["text"] === "string") text.push(part["text"])
    if (
      part["type"] === "image" &&
      isMediaType(part["media_type"]) &&
      typeof part["data"] === "string"
    )
      images.push({ mediaType: part["media_type"], data: part["data"] })
  }
  return { text: text.join("\n").trim(), images }
}
