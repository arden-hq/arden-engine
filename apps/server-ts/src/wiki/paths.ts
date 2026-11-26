import { PATH_SEGMENT } from "@arden-hq/revisions/effect"
import { posix } from "node:path"

export const canonicalWikiPath = (value: string): string | undefined => {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return undefined
  const normalized = posix.normalize(value)
  if (
    normalized === PATH_SEGMENT.current ||
    normalized.split("/")[0] === PATH_SEGMENT.parent ||
    normalized !== value
  ) {
    return undefined
  }
  return normalized
}
