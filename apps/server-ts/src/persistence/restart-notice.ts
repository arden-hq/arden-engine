import { RESTART_INTERRUPTION } from "@arden-hq/protocol/chat"

export { RESTART_INTERRUPTION }

export const RESTART_APPROVAL_DETAIL =
  "This tool was waiting for approval when Arden restarted. Approve or reject it to continue."

const LEGACY_RESTART_INTERRUPTIONS: ReadonlySet<string> = new Set([
  "The assistant run was interrupted by a server restart.",
  "interrupted by server restart"
])

export const isLegacyRestartInterruption = (text: string): boolean =>
  LEGACY_RESTART_INTERRUPTIONS.has(text.trim())

export function inArdenWords(text: string): string
export function inArdenWords(text: string | null): string | null
export function inArdenWords(text: string | null): string | null {
  return text !== null && isLegacyRestartInterruption(text) ? RESTART_INTERRUPTION : text
}
