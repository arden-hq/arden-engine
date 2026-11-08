import { cutText, foldSpace } from "./text.js"

/** A caught `unknown` as an Error: itself when it is one, else wrapped with the value as `cause`. */
export const toError = (cause: unknown): Error => {
  if (cause instanceof Error) return cause
  return new Error(String(cause), { cause })
}

/** The message of a caught unknown: an Error's own message; anything else is `fallback` when given, else its text. */
export const errorMessage = (cause: unknown, fallback?: string): string => {
  if (cause instanceof Error) return cause.message
  return fallback ?? String(cause)
}

/** Longest failure text kept in a record or sent on. */
export const FAILURE_TEXT_LIMIT = 2_000

/**
 * Failure text safe to keep: control characters and runs of space folded to one
 * space, bearer/basic credentials, `token=`-style pairs and `user:pass@` URLs
 * redacted, cut to `FAILURE_TEXT_LIMIT`.
 */
export const redactedFailureText = (text: string): string =>
  cutText(
    foldSpace(text.replace(/[\u0000-\u001f\u007f]+/gu, " "))
      .replace(/\b(Bearer|Basic)\s+\S+/giu, "$1 [redacted]")
      .replace(
        /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b\s*[:=]\s*["']?[^\s,"'}]+["']?/giu,
        "$1=[redacted]"
      )
      .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/gu, "://[redacted]@"),
    FAILURE_TEXT_LIMIT
  )
