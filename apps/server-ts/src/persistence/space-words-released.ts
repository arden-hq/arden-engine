import { parseJsonText, parseJsonTextOrUndefined } from "@arden-hq/protocol/common"

const OLD_WORD = /(desk|Desk|DESK)(?!top|Top|TOP)/
const OLD_WORDS = /(desk|Desk|DESK)(?!top|Top|TOP)/g
const APP_WRITTEN_NAME = /^[A-Za-z][A-Za-z0-9_:.~-]*$/

const NEW_WORD: Readonly<Record<string, string>> = { desk: "space", Desk: "Space", DESK: "SPACE" }
const JSON_CONTAINER_OPENERS: ReadonlySet<string> = new Set(["{", "["])
const JSON_QUOTE = '"'
const JSON_ESCAPE = "\\"

export const spaceText = (text: string): string =>
  text.replace(OLD_WORDS, (word) => NEW_WORD[word] ?? word)

export const hasOldWord = (text: string): boolean => OLD_WORD.test(text)

const looksLikeJson = (text: string): boolean => {
  const start = text.trimStart()[0]
  return start !== undefined && JSON_CONTAINER_OPENERS.has(start)
}

const parsesAsJson = (text: string): boolean => parseJsonTextOrUndefined(text) !== undefined

const convertString = (text: string): string => {
  if (!hasOldWord(text)) return text
  if (APP_WRITTEN_NAME.test(text)) return spaceText(text)
  if (looksLikeJson(text) && parsesAsJson(text)) return rewriteJsonStringTokensInPlace(text)
  return text
}

const rewriteJsonStringTokensInPlace = (text: string): string => {
  let out = ""
  let index = 0
  while (index < text.length) {
    const quote = text.indexOf(JSON_QUOTE, index)
    if (quote === -1) break
    let end = quote + 1
    while (text[end] !== JSON_QUOTE) end += text[end] === JSON_ESCAPE ? 2 : 1
    const token = text.slice(quote, end + 1)
    const decoded: unknown = parseJsonText(token)
    const converted = typeof decoded === "string" ? convertString(decoded) : decoded
    out += text.slice(index, quote) + (converted === decoded ? token : JSON.stringify(converted))
    index = end + 1
  }
  return out + text.slice(index)
}

export const spaceValue = <A>(value: A): A | string =>
  typeof value === "string" ? convertString(value) : value
