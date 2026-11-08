import { isWithin } from "@arden-hq/std/paths"
import { ToolExecutionError, type ToolApprovalPrompt } from "@arden-hq/loop"
import { Schema } from "effect"
import { mkdirSync, realpathSync, statSync } from "node:fs"
import { stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { mergePath, resolvedLoginShellPath } from "../runtime/login-shell-path.js"
import {
  type GitConfigEntry,
  SAFE_BARE_REPOSITORY,
  withGitConfig,
  withSafeGit
} from "../runtime/git-environment.js"
import {
  type CommandSandbox,
  type CommandSandboxGap,
  isCommandSandboxGap,
  resolvedCommandSandbox
} from "../runtime/command-sandbox.js"
import type { ServerApprovalPrompt } from "./define.js"
import { matchesCommand, ruleDecision, type RunRules } from "../execution/rules.js"
import type { RuleDecision } from "../persistence/permissions/rules.js"
import type { CommandGrantOffer } from "../persistence/permissions/command-policy.js"
import { type HostCommandGrantPlan, planHostCommandGrant } from "./bash-permissions.js"
import { type HiddenEntry, linuxSandboxCommand } from "./linux-sandbox.js"
import type { ServerRunContext } from "./run-context.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { skipsCards } from "../execution/decide.js"
import {
  displayLocalPath,
  type LocalPathPolicy,
  type LocalPathServices,
  policyPathOptions,
  resolveLocalPath,
  type SandboxRule,
  sandboxRule,
  sessionPathPolicy
} from "../storage/local-paths.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { toolFault, toolRefusal } from "./tool-failure.js"

export const ShellAccessSchema = Schema.Literals(["sandbox", "network", "host"] as const)
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

export const workingDirectory = async (
  services: LocalPathServices,
  input: { readonly workdir?: string; readonly access?: ShellAccess },
  ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal }
): Promise<ResolvedShell> => {
  const sessionPolicy = await sessionPathPolicy(services, {
    sessionId: ctx.run.sessionId,
    runId: ctx.run.runId,
    signal: ctx.signal
  })
  const access = input.access ?? (sessionPolicy.sandbox === "code_agent" ? "sandbox" : "host")
  const cwd =
    input.workdir === undefined
      ? (sessionPolicy.cwd ?? (access === "host" ? homedir() : null))
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
    if (access === "host") {
      return {
        cwd,
        access,
        codeAgent: sessionPolicy.sandbox === "code_agent",
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
    if (sessionPolicy.sandbox !== "code_agent" && writeRoot === undefined)
      throw toolRefusal(
        `${cwd} is not in a folder a rule lets Arden change. Use host access (its card asks), or ask the user for a folder rule.`,
        "Folder rule required"
      )
    const sandboxPolicy: LocalPathPolicy =
      sessionPolicy.sandbox === "code_agent"
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
      codeAgent: sessionPolicy.sandbox === "code_agent",
      policy: access === "network" ? { ...sandboxPolicy, network: true } : sandboxPolicy
    }
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    throw toolFault(`Working directory is unavailable: ${cwd}.`, "Working directory unavailable")
  }
}

const HOST_ENVIRONMENT_VARIABLES = [
  "SHELL",
  "USER",
  "LOGNAME",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR"
] as const

const SANDBOX_ENVIRONMENT_VARIABLES = HOST_ENVIRONMENT_VARIABLES.filter(
  (name) => name !== "SSH_AUTH_SOCK"
)

const userEnvironment = (
  { environment, loginPath, homeDirectory, temporaryDirectory }: ShellRuntime,
  names: ReadonlyArray<string>
): NodeJS.ProcessEnv => {
  const retained: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = environment[name]
    if (value !== undefined) retained[name] = value
  }
  return {
    ...retained,
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    PATH: mergePath(loginPath, environment["PATH"]),
    LANG: environment["LANG"] ?? "en_US.UTF-8",
    LC_ALL: environment["LC_ALL"] ?? "en_US.UTF-8",
    TERM: environment["TERM"] ?? "dumb",
    CI: "1",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1"
  }
}

const hostEnvironment = (runtime: ShellRuntime): NodeJS.ProcessEnv =>
  userEnvironment(runtime, HOST_ENVIRONMENT_VARIABLES)

const sandboxPath = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

/** /tmp as the sandbox matches it: /private/tmp on macOS. */
const SLASH_TMP = ((): string => {
  try {
    return realpathSync("/tmp")
  } catch {
    return "/tmp"
  }
})()

interface SandboxLocations {
  readonly temporaryDirectory: string
  readonly homeDirectory: string
  readonly ownTemporaryDirectory: string
}

const sandboxWriteRoots = (
  policy: LocalPathPolicy,
  rule: SandboxRule,
  temporaryDirectory: string
): ReadonlyArray<string> => {
  if (policy.writeRoot === null) {
    throw toolRefusal("The shell sandbox root is missing.", "Sandbox unavailable")
  }
  return [policy.writeRoot, ...rule.extraWriteRoots, temporaryDirectory, SLASH_TMP]
}

const commandSandboxRule = (
  policy: LocalPathPolicy,
  homeDirectory: string,
  platform: NodeJS.Platform
): SandboxRule => {
  const rule = sandboxRule(policy, homeDirectory, platform)
  if (rule === undefined) throw new Error("A confined command has no read rule.")
  return rule
}

/**
 * One rule for every sandboxed command, Codex's workspace-write: read the
 * whole disk, write only the command's root and temp, then deny the hidden
 * paths to reads and writes. Seatbelt reads the rules in order and a later
 * rule wins, so the denies come after every allow, and only the narrow roots
 * `sandboxRule` reopens (Skills, artifacts) follow them. A readable or
 * writable root that contains a secret (a Local folder that is HOME) cannot
 * reopen it. Installed CLIs, virtualenvs and toolchains run as they are, and
 * each agent writes only its own root, which keeps parallel agents apart.
 */
const sandboxFileRules = (
  policy: LocalPathPolicy,
  rule: SandboxRule,
  { temporaryDirectory }: SandboxLocations
): ReadonlyArray<string> => [
  "(allow file-read*)",
  ...sandboxWriteRoots(policy, rule, temporaryDirectory).map(
    (root) => `(allow file-write* (subpath "${sandboxPath(root)}"))`
  ),
  ...rule.hidden.map((root) => `(deny file-read* file-write* (subpath "${sandboxPath(root)}"))`),
  ...rule.writeProtected.map((root) => `(deny file-write* (subpath "${sandboxPath(root)}"))`),
  ...rule.writeProtectedPatterns.map((pattern) => `(deny file-write* (regex #"${pattern}"))`),
  ...rule.anchors.map(
    (root) =>
      `(deny file-write-unlink (require-all (literal "${sandboxPath(root)}") (vnode-type DIRECTORY)))`
  ),
  ...rule.reopened.map((root) => `(allow file-read* (subpath "${sandboxPath(root)}"))`)
]

const NETWORK_SANDBOX_RULES = [
  "(allow network-outbound)",
  "(deny network-outbound (remote unix-socket))",
  '(deny network-outbound (remote ip "localhost:*"))',
  '(allow network-outbound (literal "/private/var/run/mDNSResponder"))'
]

/**
 * Process inspection and signals. `ps` is setuid root and macOS refuses a
 * setuid exec inside a sandbox, so it alone runs outside it; it only reads.
 * `pgrep`/`pkill` list processes through sysmond. A sandboxed command signals
 * only processes in its own sandbox. Semaphores are allowed as in Codex's base
 * policy (Python multiprocessing needs them).
 */
const PROCESS_SANDBOX_RULES = [
  "(allow process*)",
  "(allow sysctl-read)",
  '(allow process-exec (literal "/bin/ps") (with no-sandbox))',
  '(allow mach-lookup (global-name "com.apple.sysmond"))',
  "(allow signal (target same-sandbox))",
  "(allow ipc-posix-sem)"
]

const confined = (policy: LocalPathPolicy): boolean =>
  policy.sandbox === "approved_local" || policy.sandbox === "code_agent"

const makeSandboxProfile = (
  policy: LocalPathPolicy,
  rule: SandboxRule,
  locations: SandboxLocations
): string =>
  [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    ...PROCESS_SANDBOX_RULES,
    ...(policy.network === true ? NETWORK_SANDBOX_RULES : []),
    ...sandboxFileRules(policy, rule, locations)
  ].join(" ")

/**
 * Unix sockets of local agents and daemons a Linux command could reach
 * through the read-only root: bubblewrap's own network namespace does not
 * cover a socket file. macOS closes every unix socket in the profile instead.
 */
const agentSocketPaths = (runtime: ShellRuntime, homeDirectory: string): ReadonlyArray<string> => [
  "/run/docker.sock",
  "/var/run/docker.sock",
  path.join(homeDirectory, ".docker", "run"),
  path.join(homeDirectory, ".1password"),
  ...[runtime.environment["XDG_RUNTIME_DIR"], runtime.environment["SSH_AUTH_SOCK"]].flatMap(
    (value) => (value === undefined || value.length === 0 ? [] : [value])
  )
]

const NETWORK_DENIAL =
  /could not resolve host|nodename nor servname|name or service not known|temporary failure in name resolution|network is unreachable|could not connect|failed to connect|connection refused|econnrefused|connect: operation not permitted|connect to .* operation not permitted/i

export const sandboxDenialNote = (policy: LocalPathPolicy, stderr: string): string | undefined => {
  if (policy.sandbox === null) return undefined
  if (policy.sandbox === "host_approved")
    return /operation not permitted/i.test(stderr)
      ? `[No Arden sandbox] This command ran with host access, outside any Arden sandbox, so "Operation not permitted" comes from the operating system: a privacy setting (Full Disk Access, Files and Folders), a protected system location, or a process owned by another user such as root.`
      : undefined
  if (policy.network !== true && NETWORK_DENIAL.test(stderr))
    return `[Arden sandbox] This command has no network: Arden's command sandbox blocks it, not the network itself. Run it again with access "network" to reach other machines while files stay sandboxed, or with access "host" if it also needs your logins (ssh keys, saved credentials); the user approves either.`
  if (!/operation not permitted/i.test(stderr)) return undefined
  return `[Arden sandbox] "Operation not permitted" here comes from Arden's command sandbox, not from the operating system: a sandboxed command reads everything except secret folders (keys, cloud logins, keychains, browser profiles, Arden's data), changes files only in its Local folder and temp (never Git hooks or config, .agents, .codex, shell startup files or login agents), has no network, and signals only processes it started. On macOS Git add, commit, branch, checkout and stash work in the sandbox. Run it again with access "network" for network alone, or access "host" to use those secrets, change Git config or create a repository (git init, clone, worktree add, remote add, git config), or change files elsewhere; the user approves either.`
}

const SANDBOX_GIT_CONFIG: ReadonlyArray<GitConfigEntry> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  SAFE_BARE_REPOSITORY
]

const commandEnvironment = (
  policy: LocalPathPolicy,
  options: ShellRuntime,
  locations: SandboxLocations
): NodeJS.ProcessEnv => {
  switch (policy.sandbox) {
    case "host_approved":
      return withSafeGit(hostEnvironment(options))
    case "approved_local":
    case "code_agent":
      return withGitConfig(
        {
          ...userEnvironment(
            { ...options, temporaryDirectory: locations.ownTemporaryDirectory },
            SANDBOX_ENVIRONMENT_VARIABLES
          ),
          PYTHONDONTWRITEBYTECODE: "1"
        },
        SANDBOX_GIT_CONFIG
      )
    case null:
      return withSafeGit(options.environment)
  }
}

export interface ShellRuntime {
  readonly environment: NodeJS.ProcessEnv
  readonly loginPath: string | undefined
  readonly homeDirectory: string
  readonly temporaryDirectory: string
  readonly platform: NodeJS.Platform
  readonly commandSandbox: CommandSandbox
}

export type ShellRuntimeOptions = Partial<ShellRuntime>

const loginPathFor = (options: ShellRuntimeOptions): string | undefined => {
  if ("loginPath" in options) return options.loginPath
  return options.environment === undefined ? resolvedLoginShellPath() : undefined
}

export const shellRuntime = (options: ShellRuntimeOptions): ShellRuntime => {
  const platform = options.platform ?? process.platform
  return {
    environment: options.environment ?? process.env,
    loginPath: loginPathFor(options),
    homeDirectory: options.homeDirectory ?? homedir(),
    temporaryDirectory: options.temporaryDirectory ?? tmpdir(),
    platform,
    commandSandbox:
      options.commandSandbox ??
      resolvedCommandSandbox() ??
      (platform === "linux" ? "ready" : "not_linux")
  }
}

export const sandboxUnavailableMessage = (gap: CommandSandboxGap): string => {
  switch (gap) {
    case "missing":
      return "Arden needs bubblewrap to run commands safely on Linux. Install it (for example `sudo apt install bubblewrap`) and try again."
    case "no_namespaces":
      return "Arden needs bubblewrap to run commands safely on Linux, but this system doesn't let it create user namespaces. Allow unprivileged user namespaces (on Ubuntu 24.04 and later, with an AppArmor profile for bwrap) and try again."
    case "failed":
      return "Arden needs bubblewrap to run commands safely on Linux, but it couldn't start here. Check that `bwrap --ro-bind / / true` works, then try again."
  }
}

export const sandboxUnavailable = (gap: CommandSandboxGap) =>
  toolRefusal(sandboxUnavailableMessage(gap), "Sandbox unavailable")

export interface ShellInvocation {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export const shellInvocation = (
  command: string,
  cwd: string,
  policy: LocalPathPolicy,
  runtime: ShellRuntime
): ShellInvocation => {
  const { platform } = runtime
  if (!confined(policy))
    return {
      executable: "/bin/bash",
      args: ["-c", command],
      cwd,
      env: commandEnvironment(policy, runtime, sandboxLocations(policy, runtime))
    }
  if (platform !== "darwin" && platform !== "linux") {
    throw toolRefusal("Shell isolation is not implemented on this platform.", "Sandbox unavailable")
  }
  if (platform === "linux" && isCommandSandboxGap(runtime.commandSandbox)) {
    throw sandboxUnavailable(runtime.commandSandbox)
  }
  const locations = sandboxLocations(policy, runtime)
  const env = commandEnvironment(policy, runtime, locations)
  const rule = commandSandboxRule(policy, locations.homeDirectory, platform)
  const shell = ((): { readonly executable: string; readonly args: ReadonlyArray<string> } => {
    if (platform === "linux")
      return linuxSandboxCommand({
        command,
        cwd,
        policy,
        writable: sandboxWriteRoots(policy, rule, locations.temporaryDirectory),
        // bubblewrap can only mount over a path that exists.
        hidden: existingEntries([
          ...rule.hidden,
          ...agentSocketPaths(runtime, locations.homeDirectory)
        ]),
        writeProtected: existingEntries(rule.writeProtected).map((entry) => entry.path),
        reopened: rule.reopened
      })
    return {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", makeSandboxProfile(policy, rule, locations), "/bin/bash", "-c", command]
    }
  })()
  return { executable: shell.executable, args: shell.args, cwd, env }
}

const sandboxLocations = (policy: LocalPathPolicy, runtime: ShellRuntime): SandboxLocations => {
  if (!confined(policy) || policy.writeRoot === null)
    return { temporaryDirectory: "", homeDirectory: "", ownTemporaryDirectory: "" }
  const temporaryDirectory = realpathSync(runtime.temporaryDirectory)
  const ownTemporaryDirectory = path.join(
    temporaryDirectory,
    `arden-sandbox-${sha256Hex(policy.writeRoot).slice(0, 12)}`
  )
  mkdirSync(ownTemporaryDirectory, { recursive: true, mode: 0o700 })
  return {
    temporaryDirectory,
    homeDirectory: realPathOrSelf(runtime.homeDirectory),
    ownTemporaryDirectory
  }
}

const realPathOrSelf = (target: string): string => {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

const existingEntries = (paths: ReadonlyArray<string>): ReadonlyArray<HiddenEntry> =>
  paths.flatMap((target) => {
    try {
      return [{ path: target, directory: statSync(target).isDirectory() }]
    } catch {
      return []
    }
  })

const HOST_ACCESS_LINE = "Full access to files, network and processes"

/** What a network-access card says: the file sandbox holds, the network opens. */
/**
 * What an approved network escalation reaches. On Linux bubblewrap shares the
 * host's network, so local services stay reachable until a network namespace
 * with a proxy replaces it.
 */
export const networkReach = (platform: NodeJS.Platform = process.platform): string =>
  platform === "linux"
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
  if (input.access === "sandbox") return true
  if (input.alwaysAsk) return false
  if (skipsCards(input.mode)) return true
  if (input.access === "network") return false
  return input.readsOnly && !input.codeAgent && !input.ardenData
}

const commandRule =
  (rules: RunRules) =>
  (segment: { readonly executable: string; readonly arguments: ReadonlyArray<string> }) =>
    ruleDecision(rules, matchesCommand(segment))

export const hostCommandNeed = (input: {
  readonly hostAsk: boolean
  readonly rule: RuleDecision | undefined
  readonly modeSkips: boolean
  readonly systemJob: boolean
}): "refuse" | "unlisted" | "owner_card" | "card" | "none" => {
  if (input.rule === "never") return "refuse"
  if (input.systemJob && input.rule !== "allow") return "unlisted"
  if (input.hostAsk) return "owner_card"
  if (input.rule === "ask") return "card"
  return input.modeSkips || input.rule === "allow" ? "none" : "card"
}

export const commandGrantPlan = async (
  rules: RunRules,
  command: string,
  resolved: ResolvedShell,
  options: ShellRuntime
): Promise<HostCommandGrantPlan | undefined> => {
  if (resolved.access !== "host") return undefined
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
