import { isWithin } from "@arden-hq/std/paths"
import { PLATFORM } from "@arden-hq/std/process"
import { ToolExecutionError, type ToolApprovalPrompt } from "@arden-hq/loop"
import { Schema } from "effect"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import type { ServerApprovalPrompt } from "./define.js"
import { matchesCommand, ruleDecision, type RunRules } from "../execution/rules.js"
import type { RuleDecision } from "../persistence/permissions/rules.js"
import type { CommandGrantOffer } from "../persistence/permissions/command-policy.js"
import { type HostCommandGrantPlan, planHostCommandGrant } from "./bash-permissions.js"
import type { ServerRunContext } from "./run-context.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { PERMISSION_RULE_DECISION } from "@arden-hq/protocol/permissions"
import { TERMINAL_ACCESS } from "@arden-hq/protocol/sessions/terminals"
import { skipsCards } from "../execution/decide.js"
import {
  LOCAL_SANDBOX,
  type LocalPathPolicy,
  type LocalPathServices,
  policyPathOptions,
  resolveLocalPath,
  sessionPathPolicy
} from "../storage/local-paths.js"
import { toolFault, toolRefusal } from "./tool-failure.js"
import { displayLocalPath } from "../storage/local-directory.js"
import { hostEnvironment, shellRuntime, type ShellRuntime } from "./shell-invocation.js"

export const ShellAccessSchema = Schema.Literals(Object.values(TERMINAL_ACCESS))
export type ShellAccess = typeof ShellAccessSchema.Type

const isCommandGrant = (value: unknown): value is CommandGrantOffer =>
  typeof value === "object" && value !== null && Array.isArray((value as { rules?: unknown }).rules)

export const approvalRule = (
  data: Readonly<Record<string, unknown>> | undefined
): string | undefined => {
  const words = data?.["words_grant"]
  if (typeof words === "object" && words !== null) {
    const text = (words as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  const grant = data?.["command_grant"]
  return isCommandGrant(grant)
    ? grant.rules.map((rule) => rule.display_prefix).join(", ")
    : undefined
}

export interface ResolvedShell {
  readonly cwd: string
  readonly policy: LocalPathPolicy
  readonly access: ShellAccess
  readonly codeAgent: boolean
}

export const shellAccess = (
  commandSandbox: boolean | undefined,
  asked: ShellAccess | undefined,
  codeAgent: boolean
): ShellAccess => (commandSandbox === false ? "host" : (asked ?? (codeAgent ? "sandbox" : "host")))

export const workingDirectory = async (
  services: LocalPathServices & { readonly commandSandbox?: boolean },
  input: { readonly workdir?: string; readonly access?: ShellAccess },
  ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal }
): Promise<ResolvedShell> => {
  const sessionPolicy = await sessionPathPolicy(services, {
    sessionId: ctx.run.sessionId,
    runId: ctx.run.runId,
    signal: ctx.signal
  })
  const access = shellAccess(
    services.commandSandbox,
    input.access,
    sessionPolicy.sandbox === LOCAL_SANDBOX.codeAgent
  )
  const cwd =
    input.workdir === undefined
      ? (sessionPolicy.cwd ?? (access === TERMINAL_ACCESS.host ? homedir() : null))
      : await resolveLocalPath(input.workdir, sessionPolicy.cwd, policyPathOptions(sessionPolicy))
  if (cwd === null) {
    throw toolRefusal(
      "A sandboxed command needs workdir: a folder a rule lets Arden change. Or use host access.",
      "Local folder required"
    )
  }
  try {
    if (!(await stat(cwd)).isDirectory())
      throw toolRefusal(`${cwd} is not a directory.`, "Not a directory")
    if (access === TERMINAL_ACCESS.host) {
      return {
        cwd,
        access,
        codeAgent: sessionPolicy.sandbox === LOCAL_SANDBOX.codeAgent,
        policy: {
          cwd,
          readRoots: null,
          writeRoot: null,
          stateRoot: sessionPolicy.stateRoot,
          sandbox: "host_approved",
          pathRules: sessionPolicy.pathRules
        }
      }
    }
    const writeRoot = sessionPolicy.localRoots.find((root) => isWithin(root, cwd))
    if (sessionPolicy.sandbox !== LOCAL_SANDBOX.codeAgent && writeRoot === undefined)
      throw toolRefusal(
        `${cwd} is not in a folder a rule lets Arden change. Use host access (its card asks), or ask the user for a folder rule.`,
        "Folder rule required"
      )
    const sandboxPolicy: LocalPathPolicy =
      sessionPolicy.sandbox === LOCAL_SANDBOX.codeAgent
        ? sessionPolicy
        : {
            cwd,
            readRoots: sessionPolicy.localRoots.length > 0 ? sessionPolicy.localRoots : [cwd],
            readOnlyRoots: [path.join(sessionPolicy.stateRoot, "skills")],
            writeRoot: writeRoot ?? cwd,
            stateRoot: sessionPolicy.stateRoot,
            sandbox: "approved_local",
            pathRules: sessionPolicy.pathRules
          }
    return {
      cwd,
      access,
      codeAgent: sessionPolicy.sandbox === LOCAL_SANDBOX.codeAgent,
      policy:
        access === TERMINAL_ACCESS.network ? { ...sandboxPolicy, network: true } : sandboxPolicy
    }
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    throw toolFault(`Working directory is unavailable: ${cwd}.`, "Working directory unavailable")
  }
}

const HOST_ACCESS_LINE = "Full access to files, network and processes"

export const networkReach = (platform: NodeJS.Platform = process.platform): string =>
  platform === PLATFORM.linux
    ? "other machines, and on Linux local services too"
    : "other machines, not localhost or local sockets"

const NETWORK_ACCESS_LINE = `Network on: may connect to ${networkReach()}; reads everything except secret folders, writes only its Local folder and temp`

const ARDEN_DATA_WARNING = "This command can change Arden's own data."

const ACCESS_TITLE: Record<ShellAccess, string> = {
  sandbox: "Run shell command?",
  network: "Run command with network access?",
  host: "Run this command?"
}

const ACCESS_LINE: Record<ShellAccess, string> = {
  sandbox: "Its Local folder only",
  network: NETWORK_ACCESS_LINE,
  host: HOST_ACCESS_LINE
}

export interface TypedInto {
  readonly command: string
  readonly toolCallId: string
  readonly input: string
  readonly shown: string
  readonly unknown: boolean
}

const MOVED_CURSOR_WARNING = "The input uses editing keys, so a line may run differently."

export const approvalPrompt = ({
  command,
  resolved,
  plan,
  ardenData,
  userOnly = false,
  typedInto
}: {
  readonly command: string
  readonly resolved: Pick<ResolvedShell, "cwd" | "access">
  readonly plan?: HostCommandGrantPlan | undefined
  readonly ardenData: boolean
  readonly userOnly?: boolean
  readonly typedInto?: TypedInto | undefined
}): ServerApprovalPrompt => ({
  presentation: {
    title: typedInto === undefined ? ACCESS_TITLE[resolved.access] : "Type into this command?",
    fields: [
      ...(typedInto === undefined ? [] : [{ label: "Running", value: typedInto.command }]),
      { label: "CWD", value: displayLocalPath(resolved.cwd, null) },
      { label: "Access", value: ACCESS_LINE[resolved.access] },
      ...(ardenData ? [{ label: "Warning", value: ARDEN_DATA_WARNING }] : []),
      ...(typedInto?.unknown === true ? [{ label: "Warning", value: MOVED_CURSOR_WARNING }] : [])
    ],
    ...(plan?.offer === undefined ? {} : { grant_rule: plan.displayPrefixes.join(", ") }),
    body:
      typedInto === undefined
        ? { label: "Command", text: command }
        : { label: "Input", text: typedInto.shown }
  },
  data: {
    working_directory: resolved.cwd,
    access: resolved.access,
    ...(typedInto === undefined
      ? {}
      : { typed_into: typedInto.toolCallId, input: typedInto.input }),
    ...(userOnly ? { reviewer: "user" } : {}),
    ...(plan?.offer === undefined ? {} : { command_grant: plan.offer })
  }
})

const titleCase = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`

export const withHelperRule = <P extends ToolApprovalPrompt<unknown>>(
  prompt: P,
  text: string
): P => {
  const { command_grant: _prefixes, ...data } = prompt.data ?? {}
  const presentation = prompt.presentation
  return {
    ...prompt,
    data: { ...data, words_grant: { text } },
    ...(typeof presentation === "object" && presentation !== null
      ? {
          presentation: {
            ...presentation,
            title: `${titleCase(text.replace(/[?\s]+$/u, ""))}?`,
            grant_rule: text
          }
        }
      : {})
  }
}

export const commandSkipsCard = (input: {
  readonly access: ShellAccess
  readonly mode: ChatApprovalMode
  readonly alwaysAsk: boolean
  readonly readsOnly: boolean
  readonly codeAgent: boolean
  readonly ardenData: boolean
}): boolean => {
  if (input.access === TERMINAL_ACCESS.sandbox) return true
  if (input.alwaysAsk) return false
  if (skipsCards(input.mode)) return true
  if (input.access === TERMINAL_ACCESS.network) return false
  return input.readsOnly && !input.codeAgent && !input.ardenData
}

const commandRule =
  (rules: RunRules) =>
  (segment: { readonly executable: string; readonly arguments: ReadonlyArray<string> }) =>
    ruleDecision(rules, matchesCommand(segment))

export const HOST_COMMAND_NEED = {
  refuse: "refuse",
  unlisted: "unlisted",
  ownerCard: "owner_card",
  card: "card",
  none: "none"
} as const

type HostCommandNeed = (typeof HOST_COMMAND_NEED)[keyof typeof HOST_COMMAND_NEED]

export const hostCommandNeed = (input: {
  readonly hostAsk: boolean
  readonly rule: RuleDecision | undefined
  readonly modeSkips: boolean
  readonly systemJob: boolean
}): HostCommandNeed => {
  if (input.rule === PERMISSION_RULE_DECISION.never) return HOST_COMMAND_NEED.refuse
  if (input.systemJob && input.rule !== PERMISSION_RULE_DECISION.allow)
    return HOST_COMMAND_NEED.unlisted
  if (input.hostAsk) return HOST_COMMAND_NEED.ownerCard
  if (input.rule === PERMISSION_RULE_DECISION.ask) return HOST_COMMAND_NEED.card
  return input.modeSkips || input.rule === PERMISSION_RULE_DECISION.allow
    ? HOST_COMMAND_NEED.none
    : HOST_COMMAND_NEED.card
}

export const commandGrantPlan = async (
  rules: RunRules,
  command: string,
  resolved: ResolvedShell,
  options: ShellRuntime
): Promise<HostCommandGrantPlan | undefined> => {
  if (resolved.access !== TERMINAL_ACCESS.host) return undefined
  return planHostCommandGrant({
    command,
    cwd: resolved.cwd,
    environment: hostEnvironment(options),
    rule: commandRule(rules)
  })
}

export const namedCommandGrant = async (
  rules: RunRules,
  command: string
): Promise<HostCommandGrantPlan> => {
  const runtime = shellRuntime({})
  return planHostCommandGrant({
    command,
    cwd: runtime.homeDirectory,
    environment: hostEnvironment(runtime),
    rule: commandRule(rules)
  })
}
