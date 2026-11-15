import { isRecord } from "@arden-hq/std/json"

/**
 * The model-facing text of a `context` content block, or undefined when the
 * value is not a valid one: `<content_type key="value">\n…\n</content_type>`,
 * or `<content_type key="value" />` when it has no content. Every adapter
 * sends context as this tagged text, so a model reads it the same on any wire.
 */
export const contextBlockText = (block: unknown): string | undefined => {
  if (
    !isRecord(block) ||
    block.type !== "context" ||
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
