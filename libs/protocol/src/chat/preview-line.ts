/** One readable line from an assistant message, for a row that glances at it.
 *
 *  Rows never render Markdown: they show words. So this takes the message
 *  apart the way the transcript would and keeps only what a person would
 *  read — a heading and its paragraph, list items, table cells, the label of a
 *  link, the title of a visualization — joined with the house separator and
 *  cut to one row's width. Everything that is only markup or only a machine's
 *  (code fences, comments, images, the typed reference the visualize tool
 *  places in prose) leaves. */

import { cutText } from "@arden-hq/std/text"
import { answerBlockTitle, replaceAnswerBlocks } from "./answer-blocks.js"
import { stripCitationMarkers } from "./citation-markers.js"

const ROW_WIDTH = 120

const VISUALIZATION_REFERENCE = /^\s*visualize(.+?)\s*$/

const oneLine = (title: string): string => title.replace(/\s+/g, " ").trim()

const visualizationTitle = (line: string): string | undefined => {
  const match = VISUALIZATION_REFERENCE.exec(line)
  if (!match?.[1]) return undefined
  try {
    const value = JSON.parse(match[1]) as unknown
    if (typeof value !== "object" || value === null || !("title" in value)) return ""
    return typeof value.title === "string" ? oneLine(value.title) : ""
  } catch {
    return ""
  }
}

/** The JSON value a text opens with, and whatever follows it — a workflow's
 *  return is its structured value plus a source-manifest trailer, so a
 *  whole-string parse fails while the value itself is fine. String-aware
 *  bracket matching finds the end; anything that does not parse is text. */
export const splitLeadingJson = (
  text: string
): { readonly json: string; readonly value: unknown; readonly rest: string } | null => {
  const trimmed = text.trimStart()
  const open = trimmed[0]
  if (open !== "{" && open !== "[") return null
  let depth = 0
  let inString = false
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (inString) {
      if (char === "\\") index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") depth += 1
    else if (char === "}" || char === "]") {
      depth -= 1
      if (depth === 0) {
        const json = trimmed.slice(0, index + 1)
        try {
          return { json, value: JSON.parse(json), rest: trimmed.slice(index + 1) }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const LEADING_KEYS = [
  "summary",
  "decision",
  "title",
  "message",
  "text",
  "reason",
  "outcome",
  "result"
]
const SILENT_KEYS = new Set([
  "kind",
  "status",
  "id",
  "ref",
  "path",
  "sha256",
  "bytes",
  "count",
  "url",
  "type"
])

const isWorkflowBranch = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["kind"] === "workflow_branch"

const namedBranches = (value: unknown): unknown[] | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const branches = Object.values(value)
  return branches.length > 0 && branches.every(isWorkflowBranch) ? branches : undefined
}

const firstSentence = (value: unknown): string | null => {
  if (typeof value === "string") {
    const nested = splitLeadingJson(value)
    if (nested !== null && nested.rest.trim() === "") return firstSentence(nested.value)
    const words = value.replace(/\s+/g, " ").trim()
    return words.includes(" ") && words.length >= 12 ? words : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstSentence(item)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const silent = (key: string): boolean =>
      SILENT_KEYS.has(key) || (key === "name" && isWorkflowBranch(record))
    const keys = [
      ...LEADING_KEYS.filter((key) => key in record),
      ...Object.keys(record).filter((key) => !LEADING_KEYS.includes(key) && !silent(key))
    ]
    for (const key of keys) {
      const found = firstSentence(record[key])
      if (found !== null) return found
    }
  }
  return null
}

const jsonSentences = (value: unknown, budget = 3): string[] => {
  const parts = Array.isArray(value) ? value : (namedBranches(value) ?? [value])
  const out: string[] = []
  for (const part of parts) {
    if (out.length >= budget) break
    const said = firstSentence(part)
    if (said !== null && !out.includes(said)) out.push(said)
  }
  return out
}

const unwrapSummary = (text: string): string => {
  const leading = splitLeadingJson(text)
  if (leading === null) return text
  const sentences = jsonSentences(leading.value)
  return sentences.length === 0 ? text : joinSegments(sentences)
}

const SENTENCE_END = /[.!?:;,…]["'”’)\]*_`]*$/

const joinSegments = (segments: readonly string[]): string =>
  segments.reduce((line, segment) =>
    SENTENCE_END.test(line) ? `${line} ${segment}` : `${line}, ${segment}`
  )

const BLOCK_START = /^\s*(?:[-*+]|\d+[.)])\s+|^\s*#{1,6}\s+|^\s*\|/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/
const HORIZONTAL_RULE = /^\s*(?:[-*_]\s*){3,}$/

const LINK_TARGET = String.raw`\((?:[^()]|\([^()]*\))*\)`
const IMAGE = new RegExp(String.raw`!\[[^\]]*\]${LINK_TARGET}`, "g")
const LINK = new RegExp(String.raw`\[([^\]]+)\]${LINK_TARGET}`, "g")

const tableRows = (lines: readonly string[]): ReadonlySet<number> => {
  const rows = new Set<number>()
  let inTable = false
  lines.forEach((line, index) => {
    if (line.trim() === "") inTable = false
    else if (!inTable && line.includes("|") && TABLE_RULE.test(lines[index + 1] ?? ""))
      inTable = true
    if (inTable) rows.add(index)
  })
  return rows
}

const blockWords = (line: string, tableRow: boolean): string => {
  const unmarked = line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*\[(?: |x|X)\]\s+/, "")
  const cells = tableRow
    ? unmarked
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .replace(/\s*\|\s*/g, ", ")
    : unmarked
  return cells
    .replace(IMAGE, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

const CODE_HOLD = /\uE010(\d+)\uE011/g

const inlineWords = (line: string): string => {
  const code: string[] = []
  return line
    .replace(LINK, "$1")
    .replace(/`([^`]+)`/g, (_match, text: string) => `\uE010${code.push(text) - 1}\uE011`)
    .replace(/(\*{1,3}|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu, "$2")
    .replace(CODE_HOLD, (_match, index: string) => code[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

// The closing alternative is `(?![\s\S])`, not `$`: under /m a bare `$`
// matches the end of the OPENING line, so the body captures empty and the
// refs survive into the preview as raw addresses.
const ROWS_FENCE =
  /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*arden:rows[ \t]*\n([\s\S]*?)(?:\n[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$|(?![\s\S]))/gm

const ROWS_NOUN: Record<string, readonly [string, string]> = {
  task: ["task", "tasks"],
  work: ["task", "tasks"],
  automation: ["automation", "automations"],
  session: ["chat", "chats"],
  space: ["space", "spaces"],
  memory: ["note", "notes"]
}

const rowsFenceWords = (_match: string, body: string): string => {
  const kinds = body
    .split("\n")
    .map((line) => /^\s*arden:([a-z]+)\//.exec(line.trim())?.[1])
    .filter((kind): kind is string => kind !== undefined)
  if (kinds.length === 0) return "\n\n"
  const first = kinds[0]
  const single = new Set(kinds).size === 1 && first !== undefined ? ROWS_NOUN[first] : undefined
  const noun = single ?? (["item", "items"] as const)
  return `\n\n${kinds.length} ${kinds.length === 1 ? noun[0] : noun[1]}\n\n`
}

const SOURCE_TRAILER = /(?:^|\n)[ \t]*Source manifest: \{[\s\S]*$/

/** One source line read as words: `starts` says it opens its own segment
 *  (a heading, a list item, a table row) rather than running on the line
 *  above it; `null` is a break (a blank line, a visualization without a
 *  title). */
interface LineWords {
  readonly text: string
  readonly starts: boolean
}

const readLines = (markdown: string, words: (line: string) => string): (LineWords | null)[] => {
  const source = replaceAnswerBlocks(
    stripCitationMarkers(markdown),
    (body) => `\n\n${oneLine(answerBlockTitle(body) ?? "Interactive block")}\n\n`
  )
    .replace(ROWS_FENCE, rowsFenceWords)
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
    // A comment never closed runs to the end, as Markdown reads it.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
  const lines = source.split("\n")
  const rows = tableRows(lines)
  return lines.flatMap((raw, index) => {
    const title = visualizationTitle(raw)
    if (title !== undefined) return title ? [{ text: title, starts: true }, null] : [null]
    if (TABLE_RULE.test(raw) || HORIZONTAL_RULE.test(raw)) return []
    const text = words(blockWords(raw, rows.has(index)))
    if (!text) return [null]
    return [{ text, starts: rows.has(index) || BLOCK_START.test(raw) }]
  })
}

const flatten = (
  markdown: string,
  words: (line: string) => string,
  join: (segments: readonly string[]) => string = joinSegments
): string => {
  const segments: string[] = []
  let open = false
  for (const line of readLines(markdown, words)) {
    if (line === null) open = false
    else {
      if (open && !line.starts) segments[segments.length - 1] = `${segments.at(-1)} ${line.text}`
      else segments.push(line.text)
      open = true
    }
  }
  return segments.length === 0 ? "" : join(segments)
}

const runOn = (segments: readonly string[]): string => segments.join(" ")

const messageText = (markdown: string): string =>
  unwrapSummary(stripCitationMarkers(markdown).replace(SOURCE_TRAILER, "").trim())

const FENCE_MARK = /^[ \t]{0,3}(?:`{3,}|~{3,}).*$/gm

/** Markdown down to the words a person reads, on one line and not cut: block
 *  and inline markup off, a link's label and code's text kept, and every
 *  character the writer typed inside a word (`file_name`, `a|b`) kept. The one
 *  way any surface turns Markdown into plain text (a hover card, a quote, an
 *  excerpt); it cuts the result to its own width. */
export const markdownWords = (markdown: string): string =>
  flatten(markdown, inlineWords, runOn) ||
  flatten(markdown.replace(FENCE_MARK, ""), inlineWords, runOn)

/** Each readable line of a Markdown text with its block markup off and its
 *  inline markup kept (links, code, emphasis), for a surface that picks one
 *  line and draws it with `InlineMarkup`. */
export const markdownLines = (markdown: string): string[] =>
  readLines(markdown, (words) => words).flatMap((line) => (line === null ? [] : [line.text]))

/** Plain words only, cut to one row: for places that cannot draw a link (a
 *  native notification, a menu, a window title, the clipboard). */
export const previewLine = (markdown: string | null): string | null => {
  if (markdown === null) return null
  const line = flatten(messageText(markdown), inlineWords)
  if (line.length === 0) return null
  return cutText(line, ROW_WIDTH)
}

/** The same one line with its inline markup kept (links, code, emphasis), for
 *  a row that draws links as links. Not cut: the row cuts by visible words,
 *  since a link's address takes no room on screen. */
export const previewMarkup = (markdown: string | null): string | null => {
  if (markdown === null) return null
  const line = flatten(messageText(markdown), (words) => words)
  return line.length === 0 ? null : line
}
