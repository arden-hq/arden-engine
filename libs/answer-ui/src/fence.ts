/** The fence language an answer block is written in. */
export const ANSWER_UI_FENCE = "arden:ui"

/** The largest block body, in UTF-8 bytes, that is parsed at all. A body's
 *  references inline into a tree that can double per line, so a few hundred
 *  bytes can already build a huge tree; past this size the block shows as the
 *  code it is. */
export const ANSWER_UI_MAX_BYTES = 16 * 1024

/** The largest html one block's `App` parts may carry together, in UTF-8
 *  bytes. A string inlines by reference, never by copy, so html written
 *  inline as an `App`'s second argument does not count toward the block cap;
 *  it has this cap of its own. */
export const ANSWER_UI_APP_MAX_BYTES = 150 * 1024

/** Whether a fence body is small enough to parse and draw: the body without
 *  its inline `App` html within the block cap, and that html within its own. */
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

function appHtmlSpans(body: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  let i = 0
  while (i < body.length) {
    const char = body[i]
    if (char === '"' || char === "'") {
      i = stringEnd(body, i)
      continue
    }
    const span =
      char === "A" && body.startsWith("App", i) && !isNameChar(body[i - 1])
        ? appHtmlAt(body, i + 3)
        : undefined
    if (span !== undefined) spans.push(span)
    i = span === undefined ? i + 1 : span[1] + 1
  }
  return spans
}

function appHtmlAt(body: string, from: number): readonly [number, number] | undefined {
  const open = skipSpace(body, from)
  if (body[open] !== "(") return undefined
  const title = skipSpace(body, open + 1)
  if (!isQuote(body[title])) return undefined
  const comma = skipSpace(body, stringEnd(body, title))
  if (body[comma] !== ",") return undefined
  const start = skipSpace(body, comma + 1)
  return isQuote(body[start]) ? [start + 1, stringEnd(body, start) - 1] : undefined
}

function stringEnd(body: string, start: number): number {
  const quote = body[start]
  let i = start + 1
  while (i < body.length) {
    if (body[i] === "\\") i += 2
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

const isQuote = (char: string | undefined) => char === '"' || char === "'"
const isNameChar = (char: string | undefined) => char !== undefined && /[\w$]/.test(char)

/** The UTF-8 size of `body` between `start` and `end`. */
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
