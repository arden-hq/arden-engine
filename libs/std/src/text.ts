const HIGH_SURROGATE = /[\uD800-\uDBFF]/u
const LOW_SURROGATE = /[\uDC00-\uDFFF]/u

export interface CutTextOptions {
  /** Appended after a cut, inside the budget. Default `…`; `""` for a silent cut. */
  readonly suffix?: string
  /** Back the cut up to the last space when that keeps more than 60% of the room. */
  readonly atWord?: boolean
}

/**
 * `text` cut to at most `budget` UTF-16 units, suffix included. A cut never
 * ends inside a surrogate pair, and the kept text is trimmed at the end before
 * the suffix. Text that fits comes back unchanged. A suffix longer than the
 * budget is dropped; a budget below zero counts as zero.
 */
export const cutText = (text: string, budget: number, options: CutTextOptions = {}): string => {
  const limit = Number.isNaN(budget) ? 0 : Math.max(0, Math.trunc(budget))
  if (text.length <= limit) return text
  const suffix = options.suffix ?? "…"
  const fits = suffix.length <= limit
  const room = fits ? limit - suffix.length : limit
  let end = room
  if (end > 0 && HIGH_SURROGATE.test(text.charAt(end - 1))) end -= 1
  let kept = text.slice(0, end)
  if (options.atWord === true) {
    const space = kept.lastIndexOf(" ")
    if (space > room * 0.6) kept = kept.slice(0, space)
  }
  return `${kept.trimEnd()}${fits ? suffix : ""}`
}

/** `text` with its first letter capitalised: the one sentence-case start. */
export const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Trimmed, with every run of whitespace turned into one space. */
export const foldSpace = (text: string): string => text.trim().replace(/\s+/gu, " ")

/** The one-line preview of `text`: folded, then cut to `budget` with `…`. */
export const clipLine = (text: string, budget: number): string => cutText(foldSpace(text), budget)

/** `text` matched literally inside a RegExp source. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The first line of `text` (`\n` or `\r\n`), trimmed. */
export const firstLine = (text: string): string => (text.split(/\r?\n/u, 1)[0] ?? "").trim()

const byteLength = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** Longest prefix of `text` that fits `budget` UTF-8 bytes without splitting a surrogate pair. */
export const utf8Prefix = (text: string, budget: number): string => {
  if (byteLength(text) <= budget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(text.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  if (low > 0 && HIGH_SURROGATE.test(text.charAt(low - 1))) low -= 1
  return text.slice(0, low)
}

/** Longest suffix of `text` that fits `budget` UTF-8 bytes without splitting a surrogate pair. */
export const utf8Suffix = (text: string, budget: number): string => {
  if (byteLength(text) <= budget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(text.slice(text.length - middle)) <= budget) low = middle
    else high = middle - 1
  }
  if (low > 0 && LOW_SURROGATE.test(text.charAt(text.length - low))) low -= 1
  return text.slice(text.length - low)
}

/** `text` cut to at most `budget` UTF-8 bytes, suffix included; the cut follows `utf8Prefix` and `cutText`. */
export const cutBytes = (
  text: string,
  budget: number,
  options: Pick<CutTextOptions, "suffix"> = {}
): string => {
  if (byteLength(text) <= budget) return text
  const suffix = options.suffix ?? "…"
  const fits = byteLength(suffix) <= budget
  const room = fits ? budget - byteLength(suffix) : budget
  return `${utf8Prefix(text, room).trimEnd()}${fits ? suffix : ""}`
}

/**
 * A tool call's title as the owner reads it: control characters become spaces,
 * whitespace folds, and the result is cut to `maxLength`. Anything that is not
 * a string, or folds to nothing, has no title.
 */
export const toolDisplayTitle = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const folded = foldSpace(
    Array.from(value, (character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 31 || (code >= 127 && code <= 159) ? " " : character
    }).join("")
  )
  return folded === "" ? undefined : cutText(folded, maxLength, { suffix: "" })
}
