import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import vm from "node:vm"

import { errorMessage } from "@arden-hq/std/errors"

const MAX_PATTERN_CHARS = 300
const MAX_CONTEXT_LINES = 50
const MATCH_LIMIT = 50
const LINE_CHARS = 600
const MATCH_BUDGET_MS = 1_000
const IGNORE_CASE_PREFIX = "(?i)"

export const textSelectFields = {
  grep: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PATTERN_CHARS)).annotate({
      description: `Return only the lines matching this JavaScript regular expression (escape literal . ( ) [ ] ? + * | characters; start with ${IGNORE_CASE_PREFIX} to ignore case) as number|line, with grep_context lines around each match, instead of the full text. At most ${MATCH_LIMIT} matching lines; long lines are cut around the match.`
    })
  ),
  grep_context: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CONTEXT_LINES })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
    Schema.annotateEncoded({
      description: `With grep: lines before and after each match (0-${MAX_CONTEXT_LINES}). Defaults to 0.`
    })
  )
}

export interface TextSelectOptions {
  readonly grep?: string
  readonly grep_context: number
}

export interface TextSelection {
  readonly text: string
  readonly matches: number
  readonly lines: number
  readonly shownMatches: number
  readonly truncated: boolean
}

const invalid = (message: string): ToolExecutionError =>
  new ToolExecutionError(message, { preview: "Invalid grep pattern", retryable: false })

const compile = (pattern: string, ignoreCase: boolean): string => {
  const base = ignoreCase ? "i" : ""
  try {
    new RegExp(pattern, `${base}u`)
    return `${base}u`
  } catch {
    try {
      new RegExp(pattern, base)
      return base
    } catch (cause) {
      throw invalid(
        `grep is not a valid JavaScript regular expression (${errorMessage(cause, "invalid")}); escape literal special characters with a backslash.`
      )
    }
  }
}

const timeoutScript = new vm.Script(`(() => {
  const re = new RegExp(pattern, flags)
  const hits = []
  let count = 0
  for (let i = 0; i < lines.length; i += 1) {
    const found = re.exec(lines[i])
    if (found === null) continue
    count += 1
    if (hits.length < limit * 2) hits.push(i, found.index)
  }
  return { count, hits }
})()`)

const findMatches = (
  lines: ReadonlyArray<string>,
  grep: string,
  limit: number
): { count: number; hits: ReadonlyArray<number> } => {
  const ignoreCase = grep.startsWith(IGNORE_CASE_PREFIX)
  const pattern = ignoreCase ? grep.slice(IGNORE_CASE_PREFIX.length) : grep
  const flags = compile(pattern, ignoreCase)
  try {
    return timeoutScript.runInNewContext(
      { pattern, flags, lines, limit },
      { timeout: MATCH_BUDGET_MS }
    ) as { count: number; hits: ReadonlyArray<number> }
  } catch (cause) {
    throw invalid(
      `grep took longer than ${MATCH_BUDGET_MS} ms and was stopped (${errorMessage(cause, "timeout")}); use a simpler pattern without nested repeats.`
    )
  }
}

const clip = (line: string, limit: number, matchAt: number): string => {
  if (line.length <= limit) return line
  const start = Math.max(0, Math.min(matchAt - Math.floor(limit / 3), line.length - limit))
  const end = Math.min(line.length, start + limit)
  const before = start > 0 ? `[${start} chars cut]…` : ""
  const after = end < line.length ? `…[${line.length - end} chars cut]` : ""
  return `${before}${line.slice(start, end)}${after}`
}

export const selectText = (text: string, options: TextSelectOptions): TextSelection => {
  const lines = text.split("\n")
  if (options.grep === undefined) {
    return { text, matches: 0, lines: lines.length, shownMatches: 0, truncated: false }
  }
  const { count: matches, hits } = findMatches(lines, options.grep, MATCH_LIMIT)
  const firstMatch = new Map<number, number>()
  for (let at = 0; at < hits.length; at += 2) firstMatch.set(hits[at] ?? 0, hits[at + 1] ?? 0)
  if (matches === 0) {
    return {
      text: `No lines match ${JSON.stringify(options.grep)} (${lines.length} lines searched).`,
      matches: 0,
      lines: lines.length,
      shownMatches: 0,
      truncated: false
    }
  }
  const out: Array<string> = []
  let last = -1
  for (const index of firstMatch.keys()) {
    const from = Math.max(last + 1, index - options.grep_context)
    const to = Math.min(lines.length - 1, index + options.grep_context)
    if (from > last + 1 && out.length > 0) out.push("--")
    for (let at = from; at <= to; at += 1) {
      out.push(`${at + 1}|${clip(lines[at] ?? "", LINE_CHARS, firstMatch.get(at) ?? 0)}`)
    }
    last = Math.max(last, to)
  }
  const truncated = matches > firstMatch.size
  if (truncated) {
    out.push(`[Showing ${firstMatch.size} of ${matches} matching lines; narrow grep.]`)
  }
  return {
    text: out.join("\n"),
    matches,
    lines: lines.length,
    shownMatches: firstMatch.size,
    truncated
  }
}
