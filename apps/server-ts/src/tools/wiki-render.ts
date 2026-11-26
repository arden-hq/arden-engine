import { cutText } from "@arden-hq/std/text"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { type PageRecord } from "../wiki/snapshot.js"
import { readTextPage } from "./read-text.js"
import { MAX_WIKI_CONTENT_CHARS } from "./wiki-schemas.js"

export const pageData = (
  record: PageRecord
): {
  page_ref: string
  revision: string
  path: string
  title: string
  aliases: string[]
  lifecycle: "active" | "redirect"
} => ({
  page_ref: record.page.pageId,
  revision: record.resource.versionId,
  path: record.resource.path,
  title: record.page.title,
  aliases: [...record.page.aliases],
  lifecycle: record.page.lifecycle
})

export const writtenPageData = (page: {
  readonly path: string
  readonly title: string
  readonly aliases: ReadonlyArray<string>
  readonly lifecycle: WikiPage["lifecycle"]
}): { path: string; title: string; aliases: string[]; lifecycle: string } => ({
  path: page.path,
  title: page.title,
  aliases: [...page.aliases],
  lifecycle: page.lifecycle.kind
})

const LISTING_ENTRY = { directory: "directory", page: "page" } as const

export interface ListingEntry {
  readonly kind: (typeof LISTING_ENTRY)[keyof typeof LISTING_ENTRY]
  readonly path: string
  readonly title?: string
}

export const listingEntries = (
  pages: ReadonlyArray<PageRecord>,
  directory: string
): ReadonlyArray<ListingEntry> => {
  const prefix = directory === "" ? "" : `${directory}/`
  const directories = new Set<string>()
  const entries: Array<ListingEntry> = []
  for (const record of pages) {
    const path = record.resource.path
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    if (relative === "") continue
    const separator = relative.indexOf("/")
    if (separator >= 0) {
      directories.add(`${prefix}${relative.slice(0, separator)}/`)
      continue
    }
    entries.push({ kind: LISTING_ENTRY.page, path, title: record.page.title })
  }
  return [
    ...[...directories]
      .sort()
      .map((path): ListingEntry => ({ kind: LISTING_ENTRY.directory, path })),
    ...entries.sort((left, right) => left.path.localeCompare(right.path))
  ]
}

export interface BoundedBody {
  readonly content: string
  readonly text: string
  readonly totalLines: number
  readonly truncated: boolean
}

export const boundedBody = (body: string, offset: number, limit: number): BoundedBody => {
  const page = readTextPage(body, { offset, limit })
  const sliced = page.content
  const truncatedByChars = sliced.length > MAX_WIKI_CONTENT_CHARS
  const content = truncatedByChars
    ? cutText(sliced, MAX_WIKI_CONTENT_CHARS, {
        suffix: `\n[truncated at ${MAX_WIKI_CONTENT_CHARS} characters]`
      })
    : [sliced, page.notice].filter(Boolean).join("\n\n")
  return {
    content,
    text: sliced,
    totalLines: page.total,
    truncated: truncatedByChars || page.hasMore
  }
}

export const formatListingEntry = (entry: ListingEntry): string => {
  if (entry.kind === LISTING_ENTRY.directory) return `[directory] ${entry.path}`
  return `[page] ${entry.path} — ${entry.title}`
}

export const renderListing = (
  directory: string,
  visible: ReadonlyArray<ListingEntry>,
  hasMore: boolean,
  nextOffset: number
): string => {
  const lines = visible.map(formatListingEntry)
  if (lines.length === 0) lines.push("No wiki entries.")
  if (hasMore) lines.push(`More entries exist; retry with offset=${nextOffset}.`)
  lines.push(
    "Link a page as [Title](path.md) when the user should open it. The answer's Sources footer already names what was read, so do not add a 'Source:' line."
  )
  const header = directory === "" ? "Wiki /" : `Wiki /${directory}/`
  return `${header}\n${lines.join("\n")}`
}
