import type { AskReason, CallFacts, ToolFacts } from "../execution/decide.js"
import { parseMcpSource } from "../mcp/naming.js"
import { COMMAND_TOOL } from "../persistence/permissions/command-policy.js"
import type { RuleSubject } from "../persistence/permissions/rules.js"
import { parseCommandSegments } from "./bash-permissions.js"
import { isReadOnlyCommand } from "./bash-safe-commands.js"
import type { ServerToolMetadataInput, ShellCommand } from "./define.js"
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
    per_call: definition.approvalRequirement !== undefined && metadata.requirement !== "boundary",
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
    reads_only: isReadOnlyCommand(parseCommandSegments(shell.command), shell.cwd ?? home)
  }
}

/**
 * The Allow rule a built-in tool's card may offer: the one that would have
 * let this call run without a card. Only an ask from the tool's default, or
 * from the owner's own Ask rule, is answered by a rule; a requirement, a lock,
 * a boundary, an automation's standing change and a tool that always asks
 * come before the rules are read. A delete asks every time. A connector tool
 * and a command have their own subjects.
 */
export const cardGrantSubject = (input: {
  readonly reason: AskReason
  readonly definition: DecidedTool
  readonly site: string | undefined
}): RuleSubject | undefined => {
  const { name, metadata } = input.definition
  if (input.reason !== "default" && input.reason !== "override") return undefined
  if (metadata.destructive === true || metadata.always_ask === true) return undefined
  if (name === COMMAND_TOOL || parseMcpSource(metadata.source) !== undefined) return undefined
  return input.site === undefined
    ? { kind: "tool", tool: name, server: null }
    : { kind: "site", tool: name, origin: input.site }
}
