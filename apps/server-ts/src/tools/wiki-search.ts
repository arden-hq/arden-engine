import type { SemanticMemoryMatch } from "../embedding/wiki-index.js"
import { searchTerms } from "../memory/lexical-score.js"
import { rankMemoryPages } from "../memory/retrieval.js"
import type { PageRecord } from "../wiki/snapshot.js"

const MAX_SNIPPET_CHARS = 280

interface WikiSearchMatch {
  readonly record: PageRecord
  readonly snippet: string
}

const normalized = (value: string): string => value.toLowerCase()

const window = (text: string, at: number): string => {
  if (text.length <= MAX_SNIPPET_CHARS) return text
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(MAX_SNIPPET_CHARS / 3))
  const end = Math.min(text.length, start + MAX_SNIPPET_CHARS)
  return `${start === 0 ? "" : "…"}${text.slice(start, end)}${end === text.length ? "" : "…"}`
}

/** The part of the page to show: the query as written, else the first query word found. */
const snippet = (body: string, query: string, terms: ReadonlySet<string>): string => {
  const collapsed = body.trim().split(/\s+/).join(" ")
  const text = normalized(collapsed)
  const phraseAt = text.indexOf(query)
  if (phraseAt >= 0) return window(collapsed, phraseAt)
  const wordAt = [...terms]
    .map((term) => text.indexOf(term))
    .filter((at) => at >= 0)
    .reduce((first, at) => Math.min(first, at), Number.POSITIVE_INFINITY)
  return window(collapsed, Number.isFinite(wordAt) ? wordAt : 0)
}

/** How directly a page holds the whole query as written: 0 names it, 1 names part, 2 mentions. */
const phraseTier = (record: PageRecord, query: string): number | undefined => {
  const path = normalized(record.resource.path)
  const title = normalized(record.page.title)
  const aliases = record.page.aliases.map(normalized)
  if (path === query || title === query || aliases.includes(query)) return 0
  if (
    path.includes(query) ||
    title.includes(query) ||
    aliases.some((alias) => alias.includes(query))
  )
    return 1
  return normalized(record.page.body).includes(query) ? 2 : undefined
}

/**
 * Pages that answer a query, best first. A page is found by its words, by its meaning, or by
 * holding the query as an exact phrase; no query needs to be an exact phrase.
 */
export const searchPages = (
  pages: ReadonlyArray<PageRecord>,
  text: string,
  limit: number,
  semanticMatches: ReadonlyArray<SemanticMemoryMatch> = []
): ReadonlyArray<WikiSearchMatch> => {
  const query = normalized(text).trim()
  const terms = searchTerms(query)
  const phraseMatches = pages
    .flatMap((record) => {
      const tier = phraseTier(record, query)
      return tier === undefined ? [] : [{ record, tier }]
    })
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        left.record.resource.path.localeCompare(right.record.resource.path)
    )
    .map(({ record }) => record.page.pageId)
  return rankMemoryPages({ pages, queryTerms: terms, semanticMatches, phraseMatches })
    .slice(0, limit)
    .map(({ record, excerpt }) => ({
      record,
      snippet:
        excerpt === undefined
          ? snippet(record.page.body, query, terms)
          : window(excerpt.trim().split(/\s+/).join(" "), 0)
    }))
}
