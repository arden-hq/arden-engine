import { countOf } from "@arden-hq/std/count"
import { type ToolContext } from "@arden-hq/loop"

import { sharedResourceSessions } from "../execution/authority.js"
import { approvalRule, type ResolvedShell } from "./shell-policy.js"
import { TYPED_COMMANDS, type TypedCommands } from "./typed-input.js"
import { LOCAL_SANDBOX, sessionPathPolicy } from "../storage/local-paths.js"
import { type CommandExited, MAX_CAPTURE_BYTES } from "./shell-run.js"
import type { TerminalInfo, TerminalStore } from "../terminals/store.js"
import { PROCESS_EXIT, type ProcessExit } from "../terminals/live-process.js"
import type { ServerRunContext } from "./run-context.js"
import { toolRefusal } from "./tool-failure.js"
import { type ShellToolServices } from "./exec-command-parameters.js"

export type ExitedResult = {
  readonly result: string
  readonly preview: string
  readonly data: {
    readonly output_artifact_truncated: boolean
    readonly artifact_ref?: string
    readonly exit_code: number
    readonly stdout_bytes: number
    readonly stderr_bytes: number
    readonly approval_rule?: string | undefined
    readonly cwd: string
    readonly access: string
    readonly state: string
  }
}

export const exitedResult = async (
  outcome: CommandExited,
  {
    cwd,
    access,
    preserveOutput,
    ctx
  }: {
    readonly cwd: string
    readonly access: string
    readonly preserveOutput: (bytes: Buffer, truncated: boolean) => Promise<string | undefined>
    readonly ctx: ToolContext<ServerRunContext>
  }
): Promise<ExitedResult> => {
  const artifactRef =
    outcome.fullOutput !== undefined &&
    (outcome.fullOutput.length > MAX_CAPTURE_BYTES || outcome.exitCode !== 0)
      ? await preserveOutput(outcome.fullOutput, outcome.fullOutputTruncated)
      : undefined
  const artifactNote =
    artifactRef === undefined
      ? ""
      : `\n\n${outcome.fullOutputTruncated ? "Output head and tail (middle omitted)" : "Full output"}: artifact_ref ${artifactRef}. To read it, copy it to a file with artifact_export, then use file_read.`
  if (outcome.exitCode !== 0) {
    throw toolRefusal(`${outcome.output}${artifactNote}`, `Exit ${outcome.exitCode}`)
  }
  const lines = outcome.output.split("\n").length
  return {
    result: `${outcome.output}${artifactNote}`,
    preview: `${countOf(lines, "output line")}`,
    data: {
      cwd,
      access,
      state: "exited",
      ...(ctx.approval?.grantStanding === true && approvalRule(ctx.approval.data) !== undefined
        ? { approval_rule: approvalRule(ctx.approval.data) }
        : {}),
      exit_code: outcome.exitCode,
      stdout_bytes: outcome.stdoutBytes,
      stderr_bytes: outcome.stderrBytes,
      ...(artifactRef === undefined ? {} : { artifact_ref: artifactRef }),
      output_artifact_truncated: outcome.fullOutputTruncated
    }
  }
}

export const terminalShell = async (
  services: ShellToolServices,
  terminal: TerminalInfo,
  ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal }
): Promise<Pick<ResolvedShell, "cwd" | "access" | "codeAgent">> => {
  const session = await sessionPathPolicy(services, {
    sessionId: ctx.run.sessionId,
    runId: ctx.run.runId,
    signal: ctx.signal
  })
  return {
    cwd: terminal.cwd,
    access: terminal.access,
    codeAgent: session.sandbox === LOCAL_SANDBOX.codeAgent
  }
}

export type TypedCard = {
  readonly command: string
  readonly toolCallId: string
  readonly input: string
  readonly shown: string
  readonly unknown: boolean
}

export const typedCard = (
  terminal: TerminalInfo,
  chars: string,
  commands: TypedCommands
): TypedCard => ({
  command: terminal.command,
  toolCallId: terminal.toolCallId,
  input: chars,
  shown: commands.kind === TYPED_COMMANDS.lines ? commands.shown : chars,
  unknown: commands.kind === TYPED_COMMANDS.lines && commands.unknown
})

export const reachableTerminal = (
  terminals: TerminalStore,
  id: number,
  run: ServerRunContext
): TerminalInfo | undefined => {
  const terminal = terminals.get(id)
  if (terminal === undefined || terminal.sessionId === run.sessionId) return terminal
  return sharedResourceSessions(run.authority, "agent_code").some(
    (resource) => resource.session_id === terminal.sessionId
  )
    ? terminal
    : undefined
}

export const processState = (id: number, exit: ProcessExit | undefined): string => {
  if (exit === undefined) return `Process running with session ID ${id}.`
  return exit.kind === PROCESS_EXIT.code
    ? `Process ${id} exited with code ${exit.code}.`
    : `Process ${id} was stopped (${exit.signal}).`
}

export const exitPreview = (exit: ProcessExit): string =>
  exit.kind === PROCESS_EXIT.code ? `Exit ${exit.code}` : "Stopped"
