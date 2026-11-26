import { APPROVAL_TEXT, type RunApprovalText } from "@arden-hq/protocol/runs"
import { collapseWhitespace } from "./inbox-failures.js"

const isLowerAlphaNumeric = (character: string): boolean => {
  const code = character.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122)
}

export const spokenDescription = (value: RunApprovalText): RunApprovalText => {
  if (value.kind === APPROVAL_TEXT.none) return value
  let text = value.text
  let searchFrom = 0
  while (searchFrom < text.length) {
    const open = text.indexOf("(", searchFrom)
    if (open < 0) break
    const close = text.indexOf(")", open + 1)
    if (close < 0) break
    const inner = text.slice(open + 1, close)
    const tilde = inner.indexOf("~")
    const suffix = tilde < 0 ? "" : inner.slice(tilde + 1)
    if (suffix.length >= 4 && [...suffix].every(isLowerAlphaNumeric)) {
      text = `${text.slice(0, open).trimEnd()}${text.slice(close + 1)}`
      searchFrom = open
    } else {
      searchFrom = close + 1
    }
  }
  const result = collapseWhitespace(text)
  return result.length === 0
    ? { kind: APPROVAL_TEXT.none }
    : { kind: APPROVAL_TEXT.text, text: result }
}
