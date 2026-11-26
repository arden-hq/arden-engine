import { isRecord } from "@arden-hq/std/json"
import { CONTENT_BLOCK_TYPE } from "../../contracts/messages.js"

export { isImageMediaType } from "@arden-hq/std/message-vocabulary"

export const contextBlockText = (block: unknown): string | undefined => {
  if (
    !isRecord(block) ||
    block.type !== CONTENT_BLOCK_TYPE.context ||
    typeof block.content_type !== "string" ||
    (block.content !== undefined && block.content !== null && typeof block.content !== "string")
  )
    return undefined
  const metadata = block.metadata === undefined || block.metadata === null ? {} : block.metadata
  if (!isRecord(metadata)) return undefined
  const attributes: Array<string> = []
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "string") return undefined
    attributes.push(`${key}="${value}"`)
  }
  const tag = [block.content_type, ...attributes].join(" ")
  return typeof block.content === "string" && block.content.length > 0
    ? `<${tag}>\n${block.content}\n</${block.content_type}>`
    : `<${tag} />`
}
