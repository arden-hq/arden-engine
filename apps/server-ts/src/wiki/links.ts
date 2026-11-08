import { fromMarkdown } from "mdast-util-from-markdown"

import { WikiPageFormatError } from "./errors.js"
import type { ParsedWikiPage } from "./page.js"

interface MarkdownPosition {
  readonly start: { readonly offset?: number | undefined }
  readonly end: { readonly offset?: number | undefined }
}

interface MarkdownNode {
  readonly type: string
  readonly children?: ReadonlyArray<MarkdownNode> | undefined
  readonly position?: MarkdownPosition | undefined
}

export interface WikiLinkToken {
  readonly source: string
  readonly start: number
  readonly end: number
  readonly pageStart: number | null
  readonly pageEnd: number | null
  readonly page: string | null
  readonly fragment: string | null
  readonly alias: string | null
  readonly embed: boolean
  readonly raw: string
}

const escaped = (source: string, index: number): boolean => {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

const firstUnescaped = (
  source: string,
  character: string,
  start: number,
  end: number
): number | null => {
  for (let index = start; index < end; index += 1) {
    if (source[index] === character && !escaped(source, index)) return index
  }
  return null
}

const closingBrackets = (source: string, start: number, end: number): number | null => {
  for (let index = start; index + 1 < end; index += 1) {
    const pair = source.slice(index, index + 2)
    if (pair === "[[" && !escaped(source, index)) return null
    if (pair === "]]" && !escaped(source, index)) return index
  }
  return null
}

const trimmedSpan = (source: string, start: number, end: number): readonly [number, number] => {
  let left = start
  let right = end
  while (left < right && source.charAt(left).trim().length === 0) left += 1
  while (right > left && source.charAt(right - 1).trim().length === 0) right -= 1
  return [left, right]
}

const scanText = (source: string, start: number, end: number, output: WikiLinkToken[]): void => {
  let cursor = start
  while (cursor + 1 < end) {
    if (source.slice(cursor, cursor + 2) !== "[[" || escaped(source, cursor)) {
      cursor += 1
      continue
    }
    const close = closingBrackets(source, cursor + 2, end)
    if (close === null) {
      cursor += 2
      continue
    }
    const contentStart = cursor + 2
    const aliasSeparator = firstUnescaped(source, "|", contentStart, close)
    const targetEnd = aliasSeparator ?? close
    const fragmentSeparator = firstUnescaped(source, "#", contentStart, targetEnd)
    const pageLimit = fragmentSeparator ?? targetEnd
    const [pageStart, pageEnd] = trimmedSpan(source, contentStart, pageLimit)
    const hasPage = pageStart < pageEnd
    const embed = cursor > start && source[cursor - 1] === "!" && !escaped(source, cursor - 1)
    const tokenStart = embed ? cursor - 1 : cursor
    output.push(
      Object.freeze({
        source,
        start: tokenStart,
        end: close + 2,
        pageStart: hasPage ? pageStart : null,
        pageEnd: hasPage ? pageEnd : null,
        page: hasPage ? source.slice(pageStart, pageEnd) : null,
        fragment:
          fragmentSeparator === null ? null : source.slice(fragmentSeparator + 1, targetEnd),
        alias: aliasSeparator === null ? null : source.slice(aliasSeparator + 1, close),
        embed,
        raw: source.slice(tokenStart, close + 2)
      })
    )
    cursor = close + 2
  }
}

const collectTextRanges = (node: MarkdownNode, output: Array<readonly [number, number]>): void => {
  if (node.type === "text") {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) output.push([start, end])
    return
  }
  for (const child of node.children ?? []) collectTextRanges(child, output)
}

const parseWikiLinks = (source: string): ReadonlyArray<WikiLinkToken> => {
  const tree: MarkdownNode = fromMarkdown(source)
  const ranges: Array<readonly [number, number]> = []
  collectTextRanges(tree, ranges)
  const links: WikiLinkToken[] = []
  for (const [start, end] of ranges) scanText(source, start, end, links)
  links.sort((left, right) => left.start - right.start)
  return Object.freeze(links)
}

const scanned = new WeakMap<ParsedWikiPage, ReadonlyArray<WikiLinkToken>>()

export const pageWikiLinks = (page: ParsedWikiPage): ReadonlyArray<WikiLinkToken> => {
  const cached = scanned.get(page)
  if (cached !== undefined) return cached
  const tokens = parseWikiLinks(page.body)
  scanned.set(page, tokens)
  return tokens
}

const tokenKey = (token: WikiLinkToken): string =>
  `${token.start}:${token.end}:${token.pageStart ?? ""}:${token.pageEnd ?? ""}:${token.raw}`

const validateReplacement = (replacement: string): void => {
  if (replacement.length === 0 || replacement !== replacement.trim()) {
    throw new WikiPageFormatError({ message: "wikilink replacement must be nonempty and trimmed" })
  }
  for (const character of replacement) {
    const code = character.codePointAt(0) ?? 0
    if (
      code < 32 ||
      character === "[" ||
      character === "]" ||
      character === "|" ||
      character === "#"
    ) {
      throw new WikiPageFormatError({ message: "wikilink replacement contains reserved syntax" })
    }
  }
}

export const rewriteWikiLinkTargets = (
  source: string,
  replacements: ReadonlyMap<WikiLinkToken, string>
): string => {
  if (replacements.size === 0) return source
  const current = new Set(parseWikiLinks(source).map(tokenKey))
  const edits: Array<readonly [start: number, end: number, replacement: string]> = []
  for (const [token, replacement] of replacements) {
    if (
      token.source !== source ||
      token.pageStart === null ||
      token.pageEnd === null ||
      !current.has(tokenKey(token)) ||
      source.slice(token.start, token.end) !== token.raw ||
      source.slice(token.pageStart, token.pageEnd) !== token.page
    ) {
      throw new WikiPageFormatError({ message: "wikilink token is stale or not rewritable" })
    }
    validateReplacement(replacement)
    edits.push([token.pageStart, token.pageEnd, replacement])
  }
  edits.sort((left, right) => right[0] - left[0])
  for (const [index, currentEdit] of edits.entries()) {
    const previous = edits[index - 1]
    if (previous !== undefined && currentEdit[1] > previous[0]) {
      throw new WikiPageFormatError({ message: "wikilink rewrite spans overlap" })
    }
  }
  let result = source
  for (const [start, end, replacement] of edits) {
    result = `${result.slice(0, start)}${replacement}${result.slice(end)}`
  }
  return result
}
