import { existsSync } from "node:fs"

import { runBounded } from "./login-shell-path.js"

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

export type CommandSandbox = "not_linux" | "ready" | "missing" | "no_namespaces" | "failed"

export type CommandSandboxGap = Exclude<CommandSandbox, "not_linux" | "ready">

export const isCommandSandboxGap = (status: CommandSandbox): status is CommandSandboxGap =>
  status !== "not_linux" && status !== "ready"

/**
 * Reads bubblewrap's own failure from a command's stderr: bubblewrap prefixes
 * every message with "bwrap: ", so a command's own output is never mistaken
 * for it. undefined when the output is not bubblewrap's.
 */
export const bubblewrapFailure = (stderr: string): "no_namespaces" | "failed" | undefined => {
  if (!stderr.startsWith("bwrap: ")) return undefined
  const [first = ""] = stderr.split("\n")
  return /namespace|uid map|gid map/i.test(first) ? "no_namespaces" : "failed"
}

const probeCommandSandbox = async (): Promise<CommandSandbox> => {
  if (process.platform !== "linux") return "not_linux"
  if (!existsSync(BUBBLEWRAP_PATH)) return "missing"
  const result = await runBounded(BUBBLEWRAP_PATH, SELF_TEST_ARGS, process.env, PROBE_TIMEOUT_MS)
  if (result.kind === "failed") return "failed"
  if (result.code === 0) return "ready"
  return bubblewrapFailure(result.output.trimStart()) ?? "failed"
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
