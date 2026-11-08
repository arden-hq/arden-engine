import { cutText } from "@arden-hq/std/text"
const MAX_TAIL_CHARS = 8 * 1_024
const MAX_LINE_CHARS = 1_000
const MIN_REDACTABLE_CHARS = 4
const REDACTED = "[redacted]"

const TERMINAL_ESCAPES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [
    /\b([A-Za-z_-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z_-]*)(\s*[=:]\s*)(["']?)[^\s"']{4,}/gi,
    `$1$2$3${REDACTED}`
  ]
]

export class StderrTail {
  private text = ""

  push(chunk: string): void {
    const next = this.text + chunk.replace(TERMINAL_ESCAPES, "").replace(CONTROL_CHARACTERS, "")
    if (next.length <= MAX_TAIL_CHARS) {
      this.text = next
      return
    }
    const cut = next.slice(next.length - MAX_TAIL_CHARS)
    const lineStart = cut.indexOf("\n")
    this.text = lineStart === -1 ? "" : cut.slice(lineStart + 1)
  }

  read(secrets: ReadonlyArray<string>): string | undefined {
    const text = this.text
      .split("\n")
      .map((line) => line.replace(/\r$/, "").trimEnd())
      .map((line) => cutText(line, MAX_LINE_CHARS))
      .join("\n")
      .trim()
    return text.length === 0 ? undefined : redactSecrets(text, secrets)
  }
}

export const redactSecrets = (text: string, secrets: ReadonlyArray<string>): string | undefined => {
  if (secrets.some((secret) => secret.length < MIN_REDACTABLE_CHARS)) return undefined
  const saved = [...secrets]
    .sort((left, right) => right.length - left.length)
    .reduce((current, secret) => current.split(secret).join(REDACTED), text)
  return TOKEN_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    saved
  ).slice(-MAX_TAIL_CHARS)
}

export const lastLine = (tail: string | undefined): string | undefined =>
  tail
    ?.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1)
