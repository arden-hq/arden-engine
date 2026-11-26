import { ASK_REASON, type AskReason, type CallFacts, type ToolFacts } from "../execution/decide.js"
import { parseMcpSource } from "../mcp/naming.js"
import { COMMAND_TOOL } from "../persistence/permissions/command-policy.js"
import type { RuleSubject } from "../persistence/permissions/rules.js"
import { commandReadsOnly } from "./bash-safe-commands.js"
import { TOOL_REQUIREMENT, type ServerToolMetadataInput, type ShellCommand } from "./define.js"
import { isDestructiveCommand } from "./destructive-commands.js"

interface DecidedTool {
  readonly name: string
  readonly metadata: ServerToolMetadataInput
  readonly approvalRequirement?: unknown
}

export const toolFacts = (definition: DecidedTool): ToolFacts => {
  const metadata = definition.metadata
  return {
    name: definition.name,
    effect: metadata.effect,
    action: metadata.action,
    changes_state: metadata.changes_state,
    read_only_mode: metadata.read_only_mode,
    default_approval: metadata.default_approval ?? "approve",
    always_ask: metadata.always_ask === true,
    approval_bypass: metadata.approval_bypass === true,
    refuse_unattended: metadata.refuse_unattended === true,
    per_call:
      definition.approvalRequirement !== undefined &&
      metadata.requirement !== TOOL_REQUIREMENT.boundary,
    standing: metadata.standing
  }
}

export const commandFacts = (
  shell: ShellCommand | undefined,
  home: string
): Pick<CallFacts, "floor" | "reads_only"> => {
  if (shell === undefined) return { floor: undefined, reads_only: true }
  return {
    floor: isDestructiveCommand(shell.command, { home, cwd: shell.cwd })
      ? "destructive_command"
      : undefined,
    reads_only: commandReadsOnly(shell.command, shell.cwd ?? home)
  }
}

export const cardGrantSubject = (input: {
  readonly reason: AskReason
  readonly definition: DecidedTool
  readonly site: string | undefined
}): RuleSubject | undefined => {
  const { name, metadata } = input.definition
  if (input.reason !== ASK_REASON.default && input.reason !== ASK_REASON.override) return undefined
  if (metadata.destructive === true || metadata.always_ask === true) return undefined
  if (name === COMMAND_TOOL || parseMcpSource(metadata.source) !== undefined) return undefined
  return input.site === undefined
    ? { kind: "tool", tool: name, server: null }
    : { kind: "site", tool: name, origin: input.site }
}
