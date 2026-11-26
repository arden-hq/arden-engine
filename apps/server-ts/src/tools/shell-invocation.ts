import { ToolExecutionError } from "@arden-hq/loop"
import { sha256Hex } from "@arden-hq/std/hash"
import { PLATFORM } from "@arden-hq/std/process"
import { mkdirSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import {
  type CommandSandbox,
  type CommandSandboxGap,
  isCommandSandboxGap,
  resolvedCommandSandbox
} from "../runtime/command-sandbox.js"
import {
  type GitConfigEntry,
  SAFE_BARE_REPOSITORY,
  withGitConfig,
  withSafeGit
} from "../runtime/git-environment.js"
import { mergePath, resolvedLoginShellPath } from "../runtime/login-shell-path.js"
import {
  LOCAL_SANDBOX,
  type LocalPathPolicy,
  type SandboxRule,
  sandboxRule
} from "../storage/local-paths.js"
import { COMMAND_SANDBOX_STATUS } from "@arden-hq/protocol/permissions"
import { TERMINAL_ACCESS, type TerminalAccess } from "@arden-hq/protocol/sessions/terminals"
import { type HiddenEntry, linuxSandboxCommand } from "./linux-sandbox.js"
import { toolRefusal } from "./tool-failure.js"
import { keyVariables, type VaultKeysService } from "../credentials/vault-keys.js"

const SSH_AUTH_SOCK = "SSH_AUTH_SOCK"

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
  (name) => name !== SSH_AUTH_SOCK
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

export const hostEnvironment = (runtime: ShellRuntime): NodeJS.ProcessEnv =>
  userEnvironment(runtime, HOST_ENVIRONMENT_VARIABLES)

const sandboxPath = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

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

const PROCESS_SANDBOX_RULES = [
  "(allow process*)",
  "(allow sysctl-read)",
  '(allow process-exec (literal "/bin/ps") (with no-sandbox))',
  '(allow mach-lookup (global-name "com.apple.sysmond"))',
  "(allow signal (target same-sandbox))",
  "(allow ipc-posix-sem)"
]

const confined = (policy: LocalPathPolicy): boolean =>
  policy.sandbox === LOCAL_SANDBOX.approvedLocal || policy.sandbox === LOCAL_SANDBOX.codeAgent

const keyProxyRules = (policy: LocalPathPolicy, keyProxy: KeyProxy | undefined) =>
  policy.network === true && keyProxy !== undefined
    ? [`(allow network-outbound (remote ip "localhost:${keyProxy.port}"))`]
    : []

const makeSandboxProfile = (
  policy: LocalPathPolicy,
  rule: SandboxRule,
  locations: SandboxLocations,
  keyProxy: KeyProxy | undefined
): string =>
  [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    ...PROCESS_SANDBOX_RULES,
    ...(policy.network === true ? NETWORK_SANDBOX_RULES : []),
    ...keyProxyRules(policy, keyProxy),
    ...sandboxFileRules(policy, rule, locations)
  ].join(" ")

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
  if (policy.sandbox === LOCAL_SANDBOX.hostApproved)
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
): NodeJS.ProcessEnv => ({
  ...baseEnvironment(policy, options, locations),
  ...options.keyProxy?.variables
})

const baseEnvironment = (
  policy: LocalPathPolicy,
  options: ShellRuntime,
  locations: SandboxLocations
): NodeJS.ProcessEnv => {
  switch (policy.sandbox) {
    case LOCAL_SANDBOX.hostApproved:
      return withSafeGit(hostEnvironment(options))
    case LOCAL_SANDBOX.approvedLocal:
    case LOCAL_SANDBOX.codeAgent:
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

export interface KeyProxy {
  readonly variables: Readonly<Record<string, string>>
  readonly port: number
}

export interface ShellRuntime {
  readonly environment: NodeJS.ProcessEnv
  readonly loginPath: string | undefined
  readonly homeDirectory: string
  readonly temporaryDirectory: string
  readonly platform: NodeJS.Platform
  readonly commandSandbox: CommandSandbox
  readonly keyProxy: KeyProxy | undefined
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
      (platform === PLATFORM.linux ? "ready" : "not_linux"),
    keyProxy: options.keyProxy
  }
}

export const sandboxUnavailableMessage = (gap: CommandSandboxGap): string => {
  switch (gap) {
    case COMMAND_SANDBOX_STATUS.missing:
      return "Arden needs bubblewrap to run commands safely on Linux. Install it (for example `sudo apt install bubblewrap`) and try again."
    case COMMAND_SANDBOX_STATUS.noNamespaces:
      return "Arden needs bubblewrap to run commands safely on Linux, but this system doesn't let it create user namespaces. Allow unprivileged user namespaces (on Ubuntu 24.04 and later, with an AppArmor profile for bwrap) and try again."
    case COMMAND_SANDBOX_STATUS.failed:
      return "Arden needs bubblewrap to run commands safely on Linux, but it couldn't start here. Check that `bwrap --ro-bind / / true` works, then try again."
  }
}

export const sandboxUnavailable = (gap: CommandSandboxGap): ToolExecutionError =>
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
  if (platform !== PLATFORM.darwin && platform !== PLATFORM.linux) {
    throw toolRefusal("Shell isolation is not implemented on this platform.", "Sandbox unavailable")
  }
  if (platform === PLATFORM.linux && isCommandSandboxGap(runtime.commandSandbox)) {
    throw sandboxUnavailable(runtime.commandSandbox)
  }
  const locations = sandboxLocations(policy, runtime)
  const env = commandEnvironment(policy, runtime, locations)
  const rule = commandSandboxRule(policy, locations.homeDirectory, platform)
  const shell = ((): { readonly executable: string; readonly args: ReadonlyArray<string> } => {
    if (platform === PLATFORM.linux)
      return linuxSandboxCommand({
        command,
        cwd,
        policy,
        writable: sandboxWriteRoots(policy, rule, locations.temporaryDirectory),
        hidden: existingEntries([
          ...rule.hidden,
          ...agentSocketPaths(runtime, locations.homeDirectory)
        ]),
        writeProtected: existingEntries(rule.writeProtected).map((entry) => entry.path),
        reopened: rule.reopened
      })
    return {
      executable: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        makeSandboxProfile(policy, rule, locations, runtime.keyProxy),
        "/bin/bash",
        "-c",
        command
      ]
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

export const keyProxyFor = async (
  vault: VaultKeysService,
  runId: string,
  access: TerminalAccess
): Promise<KeyProxy | undefined> => {
  if (access === TERMINAL_ACCESS.sandbox || vault.granted(runId).length === 0) return undefined
  const environment = await vault
    .environment(runId, access === TERMINAL_ACCESS.host ? "all" : "remote")
    .catch(() => {
      throw toolRefusal(
        "Arden could not prepare this run's saved keys, so the command did not run. Try again in a moment.",
        "Keys unavailable"
      )
    })
  if (environment === undefined) return undefined
  const port = Number(new URL(environment.proxyUrl).port)
  if (!Number.isInteger(port) || port < 1)
    throw toolRefusal(
      "Arden's key proxy is not running, so the command did not run.",
      "Keys unavailable"
    )
  return { variables: keyVariables(environment), port }
}
