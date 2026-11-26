import { PERMISSION_RULE_DECISION } from "@arden-hq/protocol/permissions"
import { constants } from "node:fs"
import { access, realpath } from "node:fs/promises"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import {
  commandDisplayPrefix,
  type CommandPolicyRule,
  type CommandGrantOffer
} from "../persistence/permissions/command-policy.js"
import type { RuleDecision } from "../persistence/permissions/rules.js"
import { parseCommandSegments } from "./shell-parse.js"

const NEVER_REUSABLE = new Set([
  "bash",
  "chmod",
  "chown",
  "dash",
  "dd",
  "deno",
  "env",
  "fdisk",
  "fish",
  "julia",
  "ksh",
  "lua",
  "mkfs",
  "node",
  "nodejs",
  "osascript",
  "perl",
  "php",
  "powershell",
  "powershell.exe",
  "pwsh",
  "py",
  "pypy",
  "pypy3",
  "python",
  "python3",
  "pythonw",
  "rm",
  "ruby",
  "sh",
  "sudo",
  "xargs",
  "zsh"
])

const SUBCOMMAND_DEPTH: Readonly<Record<string, number>> = {
  aws: 2,
  az: 2,
  bun: 1,
  cargo: 1,
  docker: 1,
  gcloud: 2,
  gh: 2,
  git: 1,
  helm: 1,
  kubectl: 1,
  npm: 1,
  pnpm: 1,
  podman: 1,
  terraform: 1,
  yarn: 1
}

export interface HostCommandGrantPlan {
  readonly rule: RuleDecision | undefined
  readonly offer?: CommandGrantOffer
  readonly displayPrefixes: ReadonlyArray<string>
}

const resolveExecutable = async (
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const candidates = executable.includes("/")
    ? [isAbsolute(executable) ? executable : resolve(cwd, executable)]
    : (environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) =>
          isAbsolute(entry) ? join(entry, executable) : resolve(cwd, entry, executable)
        )
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {}
  }
  return undefined
}

const suggestedRule = async (
  tokens: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<CommandPolicyRule | undefined> => {
  const executable = tokens[0]
  if (executable === undefined) return undefined
  const executablePath = await resolveExecutable(executable, cwd, environment)
  if (executablePath === undefined) return undefined
  const name = basename(executablePath).toLowerCase()
  if (NEVER_REUSABLE.has(name)) return undefined
  const depth = SUBCOMMAND_DEPTH[name] ?? 0
  const argumentPrefix: string[] = []
  for (const part of tokens.slice(1, depth + 1)) {
    if (part.startsWith("-")) return undefined
    if (!SUBCOMMAND_WORD.test(part)) break
    argumentPrefix.push(part)
  }
  if (depth > 0 && argumentPrefix.length === 0) return undefined
  return {
    executable_path: executablePath,
    argument_prefix: argumentPrefix,
    display_prefix: commandDisplayPrefix(executablePath, argumentPrefix)
  }
}

const SUBCOMMAND_WORD = /^[a-z][a-z0-9-]*$/

const uniqueRules = (rules: ReadonlyArray<CommandPolicyRule>): ReadonlyArray<CommandPolicyRule> => {
  const seen = new Set<string>()
  return rules.filter((rule) => {
    const key = JSON.stringify([rule.executable_path, rule.argument_prefix])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const unallowed = (
  decisions: ReadonlyArray<RuleDecision | undefined>
): RuleDecision | undefined => {
  if (decisions.includes(PERMISSION_RULE_DECISION.never)) return PERMISSION_RULE_DECISION.never
  return decisions.includes(PERMISSION_RULE_DECISION.ask) ? PERMISSION_RULE_DECISION.ask : undefined
}

export const planHostCommandGrant = async (input: {
  readonly command: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly rule: (segment: {
    readonly executable: string
    readonly arguments: ReadonlyArray<string>
  }) => RuleDecision | undefined
}): Promise<HostCommandGrantPlan> => {
  const segments = parseCommandSegments(input.command, { environment: input.environment })
  if (segments === undefined) return { rule: undefined, displayPrefixes: [] }
  const resolved = await Promise.all(
    segments.map(async (tokens) => {
      const candidate = await suggestedRule(tokens, input.cwd, input.environment)
      return candidate === undefined
        ? undefined
        : {
            candidate,
            rule: input.rule({
              executable: candidate.executable_path,
              arguments: tokens.slice(1)
            })
          }
    })
  )
  if (resolved.some((segment) => segment === undefined)) {
    return { rule: undefined, displayPrefixes: [] }
  }
  const decided = resolved.filter((segment) => segment !== undefined)
  const rules = uniqueRules(decided.map((segment) => segment.candidate))
  const decisions = decided.map((segment) => segment.rule)
  if (decisions.every((decision) => decision === PERMISSION_RULE_DECISION.allow))
    return {
      rule: PERMISSION_RULE_DECISION.allow,
      displayPrefixes: rules.map((rule) => rule.display_prefix)
    }
  const unmatched = uniqueRules(
    decided.flatMap((segment) => (segment.rule === undefined ? [segment.candidate] : []))
  )
  return {
    rule: unallowed(decisions),
    displayPrefixes: unmatched.map((candidate) => candidate.display_prefix),
    ...(unmatched.length === 0 ? {} : { offer: { rules: unmatched } })
  }
}
