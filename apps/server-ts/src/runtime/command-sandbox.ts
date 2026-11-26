import { existsSync } from "node:fs"

import { PROBE_RESULT, runBounded } from "./login-shell-path.js"

export const BUBBLEWRAP_PATH = "/usr/bin/bwrap"

const PROBE_TIMEOUT_MS = 3_000
const SELF_TEST_ARGS = [
  "--die-with-parent",
  "--unshare-user",
  "--unshare-pid",
  "--ro-bind",
  "/",
  "/",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "true"
] as const

const LINUX = "linux" satisfies NodeJS.Platform

const COMMAND_SANDBOX = {
  not_linux: "not_linux",
  ready: "ready",
  missing: "missing",
  no_namespaces: "no_namespaces",
  failed: "failed"
} as const

export type CommandSandbox = (typeof COMMAND_SANDBOX)[keyof typeof COMMAND_SANDBOX]

export type CommandSandboxGap = Exclude<
  CommandSandbox,
  typeof COMMAND_SANDBOX.not_linux | typeof COMMAND_SANDBOX.ready
>

export const isCommandSandboxGap = (status: CommandSandbox): status is CommandSandboxGap =>
  status !== COMMAND_SANDBOX.not_linux && status !== COMMAND_SANDBOX.ready

export const bubblewrapFailure = (
  stderr: string
): typeof COMMAND_SANDBOX.no_namespaces | typeof COMMAND_SANDBOX.failed | undefined => {
  if (!stderr.startsWith("bwrap: ")) return undefined
  const [first = ""] = stderr.split("\n")
  return /namespace|uid map|gid map/i.test(first)
    ? COMMAND_SANDBOX.no_namespaces
    : COMMAND_SANDBOX.failed
}

const probeCommandSandbox = async (): Promise<CommandSandbox> => {
  if (process.platform !== LINUX) return COMMAND_SANDBOX.not_linux
  if (!existsSync(BUBBLEWRAP_PATH)) return COMMAND_SANDBOX.missing
  const result = await runBounded(BUBBLEWRAP_PATH, SELF_TEST_ARGS, process.env, PROBE_TIMEOUT_MS)
  if (result.kind === PROBE_RESULT.failed) return COMMAND_SANDBOX.failed
  if (result.code === 0) return COMMAND_SANDBOX.ready
  return bubblewrapFailure(result.output.trimStart()) ?? COMMAND_SANDBOX.failed
}

let resolving: Promise<CommandSandbox> | undefined
let resolved: CommandSandbox | undefined

export const resolveCommandSandbox = (): Promise<CommandSandbox> => {
  if (resolving !== undefined) return resolving
  resolving = probeCommandSandbox().then(
    (status) => (resolved = status),
    () => (resolved = "failed")
  )
  return resolving
}

export const resolvedCommandSandbox = (): CommandSandbox | undefined => resolved
