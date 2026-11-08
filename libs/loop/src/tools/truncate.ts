/** The helper is pure — text in, text out. */

import { utf8Prefix, utf8Suffix } from "@arden-hq/std/text"

export const DEFAULT_TRUNCATE_MAX_BYTES = 50 * 1024
export const DEFAULT_TRUNCATE_MAX_LINES = 2_000

export interface TruncateToolResultOptions {
  /** UTF-8 byte cap for the kept text (default 51200). */
  readonly maxBytes?: number
  /** Line cap for the kept text (default 2000). */
  readonly maxLines?: number
}

const encoder = new TextEncoder()

const bytesOf = (text: string): number => encoder.encode(text).length

const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

/**
 * Truncate one tool result's model-facing text to the byte/line caps. Text
 * within both caps returns unchanged. Oversized text keeps its head and tail
 * (half the budget each) around an elision notice naming how many lines and
 * bytes were cut — both ends usually matter (the command echo and the final
 * error), which is why this keeps head+tail where opencode keeps one end.
 */
export const truncateToolResult = (
  text: string,
  options: TruncateToolResultOptions = {}
): string => {
  const maxBytes = options.maxBytes ?? DEFAULT_TRUNCATE_MAX_BYTES
  const maxLines = options.maxLines ?? DEFAULT_TRUNCATE_MAX_LINES
  if (!positiveInteger(maxBytes))
    throw new TypeError("truncateToolResult maxBytes must be a positive integer")
  if (!positiveInteger(maxLines))
    throw new TypeError("truncateToolResult maxLines must be a positive integer")

  const totalBytes = bytesOf(text)
  const lines = text.split("\n")
  if (lines.length <= maxLines && totalBytes <= maxBytes) return text

  const headLineBudget = Math.max(1, Math.floor(maxLines / 2))
  const tailLineBudget = Math.max(0, maxLines - headLineBudget)
  const headByteBudget = Math.max(1, Math.floor(maxBytes / 2))
  const tailByteBudget = Math.max(0, maxBytes - headByteBudget)

  const head: string[] = []
  let headBytes = 0
  for (const line of lines) {
    if (head.length >= headLineBudget) break
    const size = bytesOf(line) + (head.length > 0 ? 1 : 0)
    if (headBytes + size > headByteBudget) break
    head.push(line)
    headBytes += size
  }
  const firstLine = lines[0]
  if (head.length === 0 && firstLine !== undefined) {
    const slice = utf8Prefix(firstLine, headByteBudget)
    if (slice.length > 0) {
      head.push(slice)
      headBytes = bytesOf(slice)
    }
  }

  const tail: string[] = []
  let tailBytes = 0
  for (const line of lines.slice(head.length).reverse()) {
    if (tail.length >= tailLineBudget) break
    const size = bytesOf(line) + (tail.length > 0 ? 1 : 0)
    if (tailBytes + size > tailByteBudget) break
    tail.unshift(line)
    tailBytes += size
  }
  const lastLine = lines.at(-1)
  if (tail.length === 0 && tailLineBudget > 0 && tailByteBudget > 0 && lastLine !== undefined) {
    const slice = utf8Suffix(lastLine, tailByteBudget)
    if (slice.length > 0) {
      tail.unshift(slice)
      tailBytes = bytesOf(slice)
    }
  }

  const keptLines = head.length + tail.length
  const removedLines = Math.max(0, lines.length - keptLines)
  const removedBytes = Math.max(0, totalBytes - headBytes - tailBytes)
  const notice =
    removedLines > 0
      ? `[... tool output truncated: ${removedLines} of ${lines.length} lines (~${removedBytes} bytes) elided ...]`
      : `[... tool output truncated: ~${removedBytes} bytes elided ...]`

  return [head.join("\n"), notice, tail.join("\n")].filter((part) => part.length > 0).join("\n\n")
}
