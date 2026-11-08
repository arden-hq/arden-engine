/**
 * "Desk" became "Space" (migration 0141). This converts one stored value from
 * the old words to the new ones. Migration 0141 and the space_words backfill
 * both use it, so a value converts the same way everywhere. Released with
 * migration 0141: never edit it, fix forward.
 *
 * Only names the app wrote convert: a JSON key, or a whole string with no
 * spaces that starts with a letter ("desk_review", "desk:<id>", the "Desk"
 * tag, "desk_board_read"). Prose ("my desk is full") and "desktop" stay as written.
 */

const OLD_WORD = /(desk|Desk|DESK)(?!top|Top|TOP)/
const OLD_WORDS = /(desk|Desk|DESK)(?!top|Top|TOP)/g
const APP_NAME = /^[A-Za-z][A-Za-z0-9_:.~-]*$/

const NEW_WORD: Readonly<Record<string, string>> = { desk: "space", Desk: "Space", DESK: "SPACE" }

/** Replace every old word in schema or code text. */
export const spaceText = (text: string): string =>
  text.replace(OLD_WORDS, (word) => NEW_WORD[word] ?? word)

export const hasOldWord = (text: string): boolean => OLD_WORD.test(text)

const looksLikeJson = (text: string): boolean => {
  const start = text.trimStart()[0]
  return start === "{" || start === "["
}

const parsesAsJson = (text: string): boolean => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const convertString = (text: string): string => {
  if (!hasOldWord(text)) return text
  if (APP_NAME.test(text)) return spaceText(text)
  if (looksLikeJson(text) && parsesAsJson(text)) return convertJsonText(text)
  return text
}

/** Rewrite each string token of valid JSON text in place, so numbers, spacing
 * and every untouched token keep their exact text. */
const convertJsonText = (text: string): string => {
  let out = ""
  let index = 0
  while (index < text.length) {
    const quote = text.indexOf('"', index)
    if (quote === -1) break
    let end = quote + 1
    while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1
    const token = text.slice(quote, end + 1)
    const decoded: unknown = JSON.parse(token)
    const converted = typeof decoded === "string" ? convertString(decoded) : decoded
    out += text.slice(index, quote) + (converted === decoded ? token : JSON.stringify(converted))
    index = end + 1
  }
  return out + text.slice(index)
}

/** The stored value with the app's old names replaced; any other value as is. */
export const spaceValue = <A>(value: A): A | string =>
  typeof value === "string" ? convertString(value) : value
