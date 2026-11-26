import { splitAttachedFiles } from "@arden-hq/protocol/chat"
import { findTextRanges } from "@arden-hq/protocol/views"

const SNIPPET_OPEN = "\u0002"
const SNIPPET_CLOSE = "\u0003"

const LEAD_CHARS = 24
const MAX_CHARS = 160

export interface FindSnippet {
  readonly text: string
  readonly ranges: ReadonlyArray<readonly [start: number, end: number]>
}

export const findSnippet = (marked: string): FindSnippet => {
  const flat = marked
    .replace(/```[\w-]*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  let text = ""
  const ranges: Array<readonly [number, number]> = []
  let open: number | undefined
  for (const char of flat) {
    if (char === SNIPPET_OPEN) open = text.length
    else if (char === SNIPPET_CLOSE) {
      if (open !== undefined && text.length > open) ranges.push([open, text.length])
      open = undefined
    } else text += char
  }
  const first = ranges[0]?.[0] ?? 0
  let start = 0
  if (first > LEAD_CHARS) {
    const space = text.indexOf(" ", first - LEAD_CHARS)
    start = space >= 0 && space < first ? space + 1 : first - LEAD_CHARS
  }
  const end = Math.min(text.length, Math.max(start + MAX_CHARS, ranges[0]?.[1] ?? 0))
  const lead = start > 0 ? "…" : ""
  const tail = end < text.length ? "…" : ""
  const shift = lead.length - start
  return {
    text: `${lead}${text.slice(start, end).trimEnd()}${tail}`,
    ranges: ranges
      .filter(([from, to]) => from >= start && to <= end)
      .map(([from, to]) => [from + shift, to + shift] as const)
  }
}

const MARKS = new RegExp(`[${SNIPPET_OPEN}${SNIPPET_CLOSE}]`, "gu")

export const snippetWithFileNames = (marked: string, searchText: string): string => {
  const { files } = splitAttachedFiles(searchText)
  if (files.length === 0) return marked
  const lines = files.map((file) => `Attached: ${file.path}${file.directory ? "/" : ""}`)
  const nameOf = (line: string): string | undefined => {
    const plain = line.replace(MARKS, "").replace(/^…/u, "").replace(/…$/u, "")
    if (!plain.includes("/") || !lines.some((full) => full.includes(plain))) return undefined
    const body = line.replace(/\/(?=[\u0002\u0003]*…?$)/u, "")
    return body.slice(body.lastIndexOf("/") + 1)
  }
  let out = ""
  let afterName = false
  marked.split("\n").forEach((line, index) => {
    const name = nameOf(line)
    if (index > 0) out += name !== undefined && afterName ? ", " : "\n"
    out += name ?? line
    afterName = name !== undefined
  })
  return out
}

const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/u
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/gu
const MARKDOWN_LINK = /\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/gu

export const visibleText = (text: string): string =>
  text
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(MARKDOWN_IMAGE, "").replace(MARKDOWN_LINK, "$1")
    )
    .join("")

const WORD_CHAR = /[\p{L}\p{N}]/u

const foldAccents = (text: string): string =>
  text
    .split("")
    .map((unit) => {
      const base = unit.normalize("NFD").replace(/\p{M}/gu, "")
      return base.length === 1 ? base : unit
    })
    .join("")

export const wordStartRanges = (
  text: string,
  query: string
): ReadonlyArray<readonly [start: number, end: number]> | undefined => {
  const folded = foldAccents(text)
  const words = foldAccents(query)
    .split(/\s+/u)
    .filter((word) => word.length > 0)
  const perWord = words.map((word, index) =>
    indexedWordRanges(folded, { word, prefix: index === words.length - 1 })
  )
  if (perWord.length === 0 || perWord.some((ranges) => ranges.length === 0)) return undefined
  return perWord.flat().toSorted((a, b) => a[0] - b[0] || b[1] - a[1])
}

export const markWords = (text: string, query: string): string | undefined => {
  const ranges = wordStartRanges(text, query)
  return ranges === undefined ? undefined : markRanges(text, ranges)
}

export const markFtsQueryWords = (text: string, query: string): string => {
  const folded = foldAccents(text)
  const ranges = ftsQueryWords(foldAccents(query)).flatMap((term) =>
    indexedWordRanges(folded, term).map(([start, end]) => [start, wordEnd(folded, end)] as const)
  )
  return markRanges(
    text,
    ranges.toSorted((a, b) => a[0] - b[0] || b[1] - a[1])
  )
}

const WORD_REST = /[\p{L}\p{N}]*/uy

const wordEnd = (text: string, from: number): number => {
  WORD_REST.lastIndex = from
  WORD_REST.exec(text)
  return WORD_REST.lastIndex
}

interface IndexedWord {
  readonly word: string
  readonly prefix: boolean
}

const indexedWordRanges = (folded: string, { word, prefix }: IndexedWord) =>
  findTextRanges(folded, word).filter(
    ([start, end]) =>
      !WORD_CHAR.test(folded.charAt(start - 1)) && (prefix || !WORD_CHAR.test(folded.charAt(end)))
  )

const FTS_COLUMN_SEPARATOR = ":"
const FTS_PREFIX_MARKER = "*"
const FTS_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"])
const FTS_TOKEN = /,\s*\d+|"((?:[^"]|"")*)"(\*?)|([\p{L}\p{N}_]+)(\*?)(:?)/gu
const INDEX_WORD = /[\p{L}\p{N}]+/gu

const ftsQueryWords = (query: string): ReadonlyArray<IndexedWord> =>
  [...query.matchAll(FTS_TOKEN)].flatMap(([, phrase, phraseStar, bare, bareStar, column]) => {
    if (bare !== undefined && (column === FTS_COLUMN_SEPARATOR || FTS_OPERATORS.has(bare)))
      return []
    const words = [...(phrase?.replaceAll('""', '"') ?? bare ?? "").matchAll(INDEX_WORD)].map(
      ([word]) => word
    )
    const star = (phrase === undefined ? bareStar : phraseStar) === FTS_PREFIX_MARKER
    return words.map((word, index) => ({ word, prefix: star && index === words.length - 1 }))
  })

const markRanges = (
  text: string,
  ranges: ReadonlyArray<readonly [start: number, end: number]>
): string => {
  let out = ""
  let at = 0
  for (const [start, end] of ranges) {
    if (start < at) continue
    out += `${text.slice(at, start)}${SNIPPET_OPEN}${text.slice(start, end)}${SNIPPET_CLOSE}`
    at = end
  }
  return out + text.slice(at)
}
