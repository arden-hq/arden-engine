import { parseJsonText } from "../common/json-text.js"

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
    const value = parseJsonText(match[1])
    if (typeof value !== "object" || value === null || !("title" in value)) return ""
    return typeof value.title === "string" ? oneLine(value.title) : ""
  } catch {
    return ""
  }
}

const JSON_CHAR = {
  openObject: "{",
  closeObject: "}",
  openArray: "[",
  closeArray: "]",
  quote: '"',
  escape: "\\"
} as const

type JsonChar = (typeof JSON_CHAR)[keyof typeof JSON_CHAR]

const JSON_OPENERS: ReadonlySet<string | undefined> = new Set<JsonChar>([
  JSON_CHAR.openObject,
  JSON_CHAR.openArray
])
const JSON_CLOSERS: ReadonlySet<string | undefined> = new Set<JsonChar>([
  JSON_CHAR.closeObject,
  JSON_CHAR.closeArray
])

export const splitLeadingJson = (
  text: string
): { readonly json: string; readonly value: unknown; readonly rest: string } | null => {
  const trimmed = text.trimStart()
  const open = trimmed[0]
  if (!JSON_OPENERS.has(open)) return null
  let depth = 0
  let inString = false
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (inString) {
      if (char === JSON_CHAR.escape) index += 1
      else if (char === JSON_CHAR.quote) inString = false
      continue
    }
    if (char === JSON_CHAR.quote) inString = true
    else if (JSON_OPENERS.has(char)) depth += 1
    else if (JSON_CLOSERS.has(char)) {
      depth -= 1
      if (depth === 0) {
        const json = trimmed.slice(0, index + 1)
        try {
          return { json, value: parseJsonText(json), rest: trimmed.slice(index + 1) }
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

const WORKFLOW_BRANCH_KIND = "workflow_branch"
const BRANCH_NAME_KEY = "name"

const isWorkflowBranch = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === WORKFLOW_BRANCH_KIND

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
      SILENT_KEYS.has(key) || (key === BRANCH_NAME_KEY && isWorkflowBranch(record))
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

const END_OF_INPUT_UNDER_MULTILINE = String.raw`(?![\s\S])`
const ROWS_FENCE = new RegExp(
  String.raw`^[ \t]{0,3}(?:\x60{3,}|~{3,})[ \t]*arden:rows[ \t]*\n([\s\S]*?)(?:\n[ \t]{0,3}(?:\x60{3,}|~{3,})[ \t]*$|${END_OF_INPUT_UNDER_MULTILINE})`,
  "gm"
)

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

const HTML_COMMENT_UNCLOSED_RUNS_TO_END = /<!--[\s\S]*?(?:-->|$)/g

const SOURCE_TRAILER = /(?:^|\n)[ \t]*Source manifest: \{[\s\S]*$/

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
    .replace(HTML_COMMENT_UNCLOSED_RUNS_TO_END, " ")
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

const FENCE_MARK = /^[ \t]{0,3}(?:\x60{3,}|~{3,}).*$/gm

export const markdownWords = (markdown: string): string =>
  flatten(markdown, inlineWords, runOn) ||
  flatten(markdown.replace(FENCE_MARK, ""), inlineWords, runOn)

export const markdownLines = (markdown: string): string[] =>
  readLines(markdown, (words) => words).flatMap((line) => (line === null ? [] : [line.text]))

export const previewLine = (markdown: string | null): string | null => {
  if (markdown === null) return null
  const line = flatten(messageText(markdown), inlineWords)
  if (line.length === 0) return null
  return cutText(line, ROW_WIDTH)
}

export const previewMarkup = (markdown: string | null): string | null => {
  if (markdown === null) return null
  const line = flatten(messageText(markdown), (words) => words)
  return line.length === 0 ? null : line
}
