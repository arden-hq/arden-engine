import { clipLine } from "@arden-hq/std/text"

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " "
}

const CODE_WORDS =
  /\b(codes?|passcode|pin|otp|one-time|verification|verify|2fa|two-factor|2-step|log ?in|sign-?in)\b/i

export const redactText = (text: string, max: number): string => {
  const plain = text
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1")
    .replace(/(?<![\w/:.+=-])(?=[\w/+=-]*\d)(?=[\w/+=-]*[A-Za-z])[\w/+=-]{20,}/g, "[redacted]")
    .replace(/\b\d{3}[- ]\d{3}\b|\b\d{5,}\b/g, "[number]")
  const coded = CODE_WORDS.test(plain)
    ? plain
        .replace(/\b\d{4}\b/g, "[number]")
        .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}\b/g, "[redacted]")
    : plain
  return clipLine(coded, max)
}
