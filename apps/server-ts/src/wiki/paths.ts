import { posix } from "node:path"

export const canonicalWikiPath = (value: string): string | undefined => {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return undefined
  const normalized = posix.normalize(value)
  if (normalized === "." || normalized.split("/")[0] === ".." || normalized !== value) {
    return undefined
  }
  return normalized
}
