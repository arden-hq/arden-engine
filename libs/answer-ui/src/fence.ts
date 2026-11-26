import type { ComponentName } from "./parts.js"

export const ANSWER_UI_FENCE = "arden:ui"

export const ANSWER_UI_MAX_BYTES = 16 * 1024

export const ANSWER_UI_APP_MAX_BYTES = 150 * 1024

export function answerBlockFits(body: string): boolean {
  if (body.length * 3 <= ANSWER_UI_MAX_BYTES) return true
  if (body.length > ANSWER_UI_MAX_BYTES + ANSWER_UI_APP_MAX_BYTES) return false
  const html = appHtmlSpans(body).reduce(
    (total, [start, end]) => total + utf8Bytes(body, start, end),
    0
  )
  return (
    html <= ANSWER_UI_APP_MAX_BYTES && utf8Bytes(body, 0, body.length) - html <= ANSWER_UI_MAX_BYTES
  )
}

const APP_PART = "App" satisfies ComponentName

const FENCE_CHAR = {
  doubleQuote: '"',
  singleQuote: "'",
  backslash: "\\",
  open: "(",
  comma: ","
} as const
type Quote = typeof FENCE_CHAR.doubleQuote | typeof FENCE_CHAR.singleQuote
const QUOTES: ReadonlySet<string | undefined> = new Set<Quote>([
  FENCE_CHAR.doubleQuote,
  FENCE_CHAR.singleQuote
])
const isQuote = (char: string | undefined): char is Quote => QUOTES.has(char)

function appHtmlSpans(body: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  let i = 0
  while (i < body.length) {
    if (isQuote(body[i])) {
      i = stringEnd(body, i)
      continue
    }
    const span =
      body.startsWith(APP_PART, i) && !isNameChar(body[i - 1])
        ? appHtmlAt(body, i + APP_PART.length)
        : undefined
    if (span !== undefined) spans.push(span)
    i = span === undefined ? i + 1 : span[1] + 1
  }
  return spans
}

function appHtmlAt(body: string, from: number): readonly [number, number] | undefined {
  const open = skipSpace(body, from)
  if (body[open] !== FENCE_CHAR.open) return undefined
  const title = skipSpace(body, open + 1)
  if (!isQuote(body[title])) return undefined
  const comma = skipSpace(body, stringEnd(body, title))
  if (body[comma] !== FENCE_CHAR.comma) return undefined
  const start = skipSpace(body, comma + 1)
  return isQuote(body[start]) ? [start + 1, stringEnd(body, start) - 1] : undefined
}

function stringEnd(body: string, start: number): number {
  const quote = body[start]
  let i = start + 1
  while (i < body.length) {
    if (body[i] === FENCE_CHAR.backslash) i += 2
    else if (body[i] === quote) return i + 1
    else i += 1
  }
  return body.length
}

function skipSpace(body: string, from: number): number {
  let i = from
  while (i < body.length && /\s/.test(body[i] ?? "")) i += 1
  return i
}

const isNameChar = (char: string | undefined) => char !== undefined && /[\w$]/.test(char)

export function utf8Bytes(body: string, start = 0, end = body.length): number {
  let bytes = 0
  for (let i = start; i < end; i++) {
    const unit = body.charCodeAt(i)
    bytes += unit >= 0xd800 && unit <= 0xdfff ? 2 : utf8Length(unit)
  }
  return bytes
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}
