import { cutText, foldSpace } from "./text.js"

export const toError = (cause: unknown): Error => {
  if (cause instanceof Error) return cause
  return new Error(String(cause), { cause })
}

export const errorMessage = (cause: unknown, fallback?: string): string => {
  if (cause instanceof Error) return cause.message
  return fallback ?? String(cause)
}

export const FAILURE_TEXT_LIMIT = 2_000

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

export const ERRNO = {
  EEXIST: "EEXIST",
  ENOENT: "ENOENT",
  ENOTEMPTY: "ENOTEMPTY",
  ELOOP: "ELOOP",
  EACCES: "EACCES",
  ENOEXEC: "ENOEXEC"
} as const

export type ErrnoCode = (typeof ERRNO)[keyof typeof ERRNO]

export const isErrnoCode = (cause: unknown, code: ErrnoCode): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code
