import { cutText, foldSpace, type CutTextOptions } from "./text.js"

const grouping = new Intl.NumberFormat("en-US")

/** A count with its digits grouped one way everywhere: `12,345`. */
export const groupedCount = (n: number): string => grouping.format(n)

const written = (amount: number): string =>
  amount >= 100 ? String(Math.round(amount)) : amount.toFixed(1).replace(/\.0$/u, "")

const COMPACT_TIERS = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"]
] as const

/** A count too large to read digit by digit: `950`, `1.5K`, `12M`, `250B`. A value that rounds up to the next tier ("1000K") reads in it ("1M"). */
export const compactCount = (value: number): string => {
  for (const [index, [unit, suffix]] of COMPACT_TIERS.entries()) {
    if (value < unit) continue
    const text = written(value / unit)
    const above = COMPACT_TIERS[index - 1]
    return above !== undefined && Number(text) >= 1000 ? `1${above[1]}` : text + suffix
  }
  return String(value)
}

/**
 * The noun for `n`: `one` at exactly 1, else `many`, else `one` with the
 * regular ending (`es` after s, x, z, ch, sh; `ies` after a consonant and y).
 * Irregular nouns pass `many` (criterion, criteria).
 */
export const nounFor = (n: number, one: string, many?: string): string => {
  if (n === 1) return one
  if (many !== undefined) return many
  if (/[^aeiou]y$/i.test(one)) return `${one.slice(0, -1)}ies`
  return /(s|x|z|ch|sh)$/i.test(one) ? `${one}es` : `${one}s`
}

/** `1 file`, `1,234 files`, `0 entries`. */
export const countOf = (n: number, one: string, many?: string): string =>
  `${groupedCount(n)} ${nounFor(n, one, many)}`

const BYTE_UNITS = ["KB", "MB", "GB"] as const

/**
 * A size in words, binary (1 KB = 1024 B) with the labels people read:
 * `512 B`, `4 KB`, `4.3 MB`, `1.9 GB`. One decimal, dropped when it is zero;
 * a size that rounds up to the next unit (1,048,575 B) is named in that unit.
 * `{ base: 1000 }` counts in decimal units, for a figure a provider states that way.
 */
export const formatBytes = (
  bytes: number,
  options: { readonly base?: 1000 | 1024 } = {}
): string => {
  const base = options.base ?? 1024
  if (!(bytes >= base)) return `${Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0} B`
  let value = bytes / base
  let unit = 0
  while (unit < BYTE_UNITS.length - 1 && Math.round(value * 10) / 10 >= base) {
    value /= base
    unit += 1
  }
  return `${Number((Math.round(value * 10) / 10).toFixed(1))} ${BYTE_UNITS[unit]}`
}

/** `a`, `a and b`, `a, b and c`; `or` for a choice. No Oxford comma. */
export const listWords = (items: readonly string[], joiner: "and" | "or" = "and"): string =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`

/**
 * A name inside a sentence: `“Bills watch”`. The name is put on one line;
 * `max` (UTF-16 units, ellipsis included; cutText) cuts a longer one.
 */
export const quoted = (name: string, max?: number, options?: CutTextOptions): string =>
  `“${max === undefined ? foldSpace(name) : cutText(foldSpace(name), max, options)}”`
