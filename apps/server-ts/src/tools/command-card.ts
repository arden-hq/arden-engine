import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { APPROVAL_MODE, PERMISSION_RULE_DECISION } from "@arden-hq/protocol/permissions"
import { TERMINAL_ACCESS } from "@arden-hq/protocol/sessions/terminals"
import { Effect } from "effect"
import type { RunAuthority } from "../execution/authority.js"
import {
  isSystemJobRun,
  matchesHostCommands,
  readRunRules,
  ruleDecision,
  type RunRules
} from "../execution/rules.js"
import type { PermissionRules } from "../persistence/permissions/rules.js"
import { ardenDataRoots, mentionsArdenData } from "./arden-data-mention.js"
import type { HostCommandGrantPlan } from "./bash-permissions.js"
import { commandReadsOnly } from "./bash-safe-commands.js"
import type { ServerApprovalPrompt } from "./define.js"
import {
  approvalPrompt,
  commandSkipsCard,
  HOST_COMMAND_NEED,
  hostCommandNeed,
  type ResolvedShell,
  type TypedInto
} from "./shell-policy.js"
import { toolRefusal } from "./tool-failure.js"

interface CommandCardServices {
  readonly rules: PermissionRules["Service"]
  readonly dataDir: string
}

export const namesArdenData = (
  services: CommandCardServices,
  command: string,
  resolved: Pick<ResolvedShell, "cwd" | "access">
): boolean =>
  resolved.access === TERMINAL_ACCESS.host &&
  mentionsArdenData({ command, cwd: resolved.cwd, roots: ardenDataRoots(services.dataDir) })

export const commandCard = async (
  services: CommandCardServices,
  input: {
    readonly command: string
    readonly resolved: Pick<ResolvedShell, "cwd" | "access" | "codeAgent">
    readonly mode: ChatApprovalMode
    readonly authority: RunAuthority
    readonly plan?: (rules: RunRules) => Promise<HostCommandGrantPlan | undefined>
    readonly typedInto?: TypedInto
  }
): Promise<ServerApprovalPrompt | undefined> => {
  const { command, resolved } = input
  if (resolved.access === TERMINAL_ACCESS.sandbox) return undefined
  const ardenData = namesArdenData(services, command, resolved)
  const rules = await Effect.runPromise(readRunRules(services.rules, input.authority)).catch(
    () => undefined
  )
  const alwaysAsk =
    rules === undefined || ruleDecision(rules, matchesHostCommands) === PERMISSION_RULE_DECISION.ask
  const skips = commandSkipsCard({
    access: resolved.access,
    mode: input.mode,
    alwaysAsk,
    readsOnly: input.typedInto?.unknown !== true && commandReadsOnly(command, resolved.cwd),
    codeAgent: resolved.codeAgent,
    ardenData
  })
  const plan = rules === undefined ? undefined : await input.plan?.(rules)
  const need = hostCommandNeed({
    hostAsk: alwaysAsk,
    rule: plan?.rule,
    modeSkips: skips,
    systemJob: isSystemJobRun(input.authority)
  })
  if (need === HOST_COMMAND_NEED.refuse)
    throw toolRefusal(
      `The user's rule says Arden never runs ${plan?.displayPrefixes.join(", ") ?? "this command"} on their Mac. Do not try another way; say what you needed instead.`,
      "A rule refuses this command"
    )
  if (need === HOST_COMMAND_NEED.unlisted)
    throw toolRefusal(
      "No rule for Arden's own jobs allows this command, so it was not run. Do not try another way; say which command you needed and that the owner can allow it for Arden's own jobs.",
      "No rule allows this command"
    )
  if (need === HOST_COMMAND_NEED.none || input.mode === APPROVAL_MODE.readOnly) return undefined
  return approvalPrompt({
    command,
    resolved,
    plan,
    ardenData,
    userOnly: need === HOST_COMMAND_NEED.ownerCard,
    typedInto: input.typedInto
  })
}
