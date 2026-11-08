import { formatDuration } from "@arden-hq/std/time"
import { cutText } from "@arden-hq/std/text"

import { McpTimeoutError } from "./client.js"
import { lastLine } from "./stderr-tail.js"

export type McpFailureDetail =
  | {
      readonly reason: "command_not_found"
      readonly command: string
      readonly pathSource: "login_shell" | "process"
    }
  | { readonly reason: "not_executable"; readonly path: string }
  /** The saved working folder is missing or not a folder. */
  | { readonly reason: "bad_folder"; readonly folder: string }
  /** The process ended before it answered the handshake. */
  | { readonly reason: "exited_early"; readonly stderr: string | undefined }
  /** The process ran but did not answer the handshake in time. */
  | { readonly reason: "timeout"; readonly seconds: number }
  /** It connected, then stopped again after every automatic restart. */
  | { readonly reason: "crashed"; readonly stderr: string | undefined }

export type McpFailureReason = McpFailureDetail["reason"]

export class McpStartFailure extends Error {
  constructor(readonly detail: McpFailureDetail) {
    super(mcpFailureSentence(detail))
    this.name = "McpStartFailure"
  }
}

export const mcpFailureSentence = (detail: McpFailureDetail): string => {
  switch (detail.reason) {
    case "command_not_found":
      return detail.pathSource === "login_shell"
        ? `Arden can’t find \`${cutText(detail.command, COMMAND_CHARS)}\` on your PATH. Install it, or use its full path.`
        : `Arden can’t find \`${cutText(detail.command, COMMAND_CHARS)}\` on your PATH, and couldn’t read your shell’s PATH. Install it, or use its full path.`
    case "not_executable":
      return `\`${cutText(detail.path, COMMAND_CHARS)}\` isn’t a program Arden can run.`
    case "bad_folder":
      return `The folder \`${cutText(detail.folder, COMMAND_CHARS)}\` doesn’t exist.`
    case "exited_early":
      return withLastLine("The server exited during start", detail.stderr)
    case "timeout":
      return `The server didn’t answer within ${formatDuration(detail.seconds * 1000)}.`
    case "crashed":
      return withLastLine("The server keeps stopping", detail.stderr)
  }
}

export const classifyMcpStartFailure = ({
  cause,
  executable,
  exited,
  stderr
}: {
  readonly cause: unknown
  readonly executable: string | undefined
  readonly exited: boolean
  readonly stderr: string | undefined
}): McpFailureDetail | undefined => {
  if (cause instanceof McpStartFailure) return cause.detail
  if (cause instanceof McpTimeoutError) {
    return { reason: "timeout", seconds: Math.round(cause.timeoutMs / 1_000) }
  }
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined
  if (executable !== undefined && (code === "EACCES" || code === "ENOEXEC")) {
    return { reason: "not_executable", path: executable }
  }
  return exited ? { reason: "exited_early", stderr } : undefined
}

const withLastLine = (sentence: string, stderr: string | undefined): string => {
  const line = lastLine(stderr)
  return line === undefined ? `${sentence}.` : `${sentence}: ${cutText(line, 600)}`
}

const COMMAND_CHARS = 200
