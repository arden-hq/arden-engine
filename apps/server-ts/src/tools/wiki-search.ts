import type { PageRecord } from "../wiki/snapshot.js"

const MAX_SNIPPET_CHARS = 280

interface WikiSearchMatch {
  readonly record: PageRecord
  readonly score: number
  readonly snippet: string
}

const normalized = (value: string): string => value.toLowerCase()

const snippet = (body: string, query: string): string => {
  const collapsed = body.trim().split(/\s+/).join(" ")
  if (collapsed.length <= MAX_SNIPPET_CHARS) return collapsed
  const matchAt = normalized(collapsed).indexOf(query)
  const start = Math.max(0, matchAt < 0 ? 0 : matchAt - Math.floor(MAX_SNIPPET_CHARS / 3))
  const end = Math.min(collapsed.length, start + MAX_SNIPPET_CHARS)
  return `${start === 0 ? "" : "…"}${collapsed.slice(start, end)}${end === collapsed.length ? "" : "…"}`
}

const searchMatch = (record: PageRecord, query: string): WikiSearchMatch | undefined => {
  const path = normalized(record.resource.path)
  const title = normalized(record.page.title)
  const aliases = record.page.aliases.map(normalized)
  const body = normalized(record.page.body)
  if (path === query || title === query || aliases.includes(query)) {
    return { record, score: 0, snippet: snippet(record.page.body, query) }
  }
  if (
    path.includes(query) ||
    title.includes(query) ||
    aliases.some((alias) => alias.includes(query))
  ) {
    return { record, score: 1, snippet: snippet(record.page.body, query) }
  }
  return body.includes(query)
    ? { record, score: 2, snippet: snippet(record.page.body, query) }
    : undefined
}

const compareSearchMatches = (left: WikiSearchMatch, right: WikiSearchMatch): number =>
  left.score === right.score
    ? left.record.resource.path.localeCompare(right.record.resource.path)
    : left.score - right.score

export const searchPages = (
  pages: ReadonlyArray<PageRecord>,
  text: string,
  limit: number
): ReadonlyArray<WikiSearchMatch> => {
  const query = normalized(text)
  return pages
    .map((record) => searchMatch(record, query))
    .filter((match): match is WikiSearchMatch => match !== undefined)
    .sort(compareSearchMatches)
    .slice(0, limit)
}
