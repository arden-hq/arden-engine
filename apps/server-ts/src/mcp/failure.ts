import { formatDuration } from "@arden-hq/std/time"
import { cutText } from "@arden-hq/std/text"
import { ERRNO, isErrnoCode } from "@arden-hq/std/errors"
import { CLI_TOOLS_PATH_SOURCE, type CliToolsPathSource } from "@arden-hq/protocol/cli-tools"

import { McpTimeoutError } from "./client.js"
import { lastLine } from "./stderr-tail.js"

export const MCP_FAILURE_REASON = {
  commandNotFound: "command_not_found",
  notExecutable: "not_executable",
  badFolder: "bad_folder",
  exitedEarly: "exited_early",
  timeout: "timeout",
  crashed: "crashed"
} as const

export type McpFailureDetail =
  | {
      readonly reason: typeof MCP_FAILURE_REASON.commandNotFound
      readonly command: string
      readonly pathSource: CliToolsPathSource
    }
  | { readonly reason: typeof MCP_FAILURE_REASON.notExecutable; readonly path: string }
  | { readonly reason: typeof MCP_FAILURE_REASON.badFolder; readonly folder: string }
  | { readonly reason: typeof MCP_FAILURE_REASON.exitedEarly; readonly stderr: string | undefined }
  | { readonly reason: typeof MCP_FAILURE_REASON.timeout; readonly seconds: number }
  | { readonly reason: typeof MCP_FAILURE_REASON.crashed; readonly stderr: string | undefined }

export type McpFailureReason = McpFailureDetail["reason"]

export class McpStartFailure extends Error {
  constructor(readonly detail: McpFailureDetail) {
    super(mcpFailureSentence(detail))
    this.name = "McpStartFailure"
  }
}

export const mcpFailureSentence = (detail: McpFailureDetail): string => {
  switch (detail.reason) {
    case MCP_FAILURE_REASON.commandNotFound:
      return detail.pathSource === CLI_TOOLS_PATH_SOURCE.loginShell
        ? `Arden can’t find \`${cutText(detail.command, COMMAND_CHARS)}\` on your PATH. Install it, or use its full path.`
        : `Arden can’t find \`${cutText(detail.command, COMMAND_CHARS)}\` on your PATH, and couldn’t read your shell’s PATH. Install it, or use its full path.`
    case MCP_FAILURE_REASON.notExecutable:
      return `\`${cutText(detail.path, COMMAND_CHARS)}\` isn’t a program Arden can run.`
    case MCP_FAILURE_REASON.badFolder:
      return `The folder \`${cutText(detail.folder, COMMAND_CHARS)}\` doesn’t exist.`
    case MCP_FAILURE_REASON.exitedEarly:
      return withLastLine("The server exited during start", detail.stderr)
    case MCP_FAILURE_REASON.timeout:
      return `The server didn’t answer within ${formatDuration(detail.seconds * 1000)}.`
    case MCP_FAILURE_REASON.crashed:
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
    return { reason: MCP_FAILURE_REASON.timeout, seconds: Math.round(cause.timeoutMs / 1_000) }
  }
  if (
    executable !== undefined &&
    cause instanceof Error &&
    (isErrnoCode(cause, ERRNO.EACCES) || isErrnoCode(cause, ERRNO.ENOEXEC))
  ) {
    return { reason: MCP_FAILURE_REASON.notExecutable, path: executable }
  }
  return exited ? { reason: MCP_FAILURE_REASON.exitedEarly, stderr } : undefined
}

const withLastLine = (sentence: string, stderr: string | undefined): string => {
  const line = lastLine(stderr)
  return line === undefined ? `${sentence}.` : `${sentence}: ${cutText(line, 600)}`
}

const COMMAND_CHARS = 200
