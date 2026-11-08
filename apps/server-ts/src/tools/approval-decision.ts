import type { CallFacts, ToolFacts } from "../execution/decide.js"
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
