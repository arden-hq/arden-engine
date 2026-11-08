import { spawn } from "node:child_process"
import { basename, delimiter, isAbsolute } from "node:path"
import { withSafeGit } from "./git-environment.js"
import { signalProcessGroup } from "@arden-hq/std/process"
/**
 * The PATH the person's own terminal sees. An app started from the Dock
 * inherits launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`, so Homebrew, npm
 * and the like are missing until the login shell is asked once.
 */

const LOGIN_SHELL_TIMEOUT_MS = 3_000
const PROBE_TIMEOUT_MS = 4_000
const MAX_OUTPUT_BYTES = 64 * 1024
const KNOWN_SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh"])
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin"

const PATH_MARKER = "__ARDEN_PATH__"

const parseShellPath = (output: string): string | undefined => {
  const start = output.indexOf(PATH_MARKER)
  if (start === -1) return undefined
  const end = output.indexOf(PATH_MARKER, start + PATH_MARKER.length)
  if (end === -1) return undefined
  const value = output.slice(start + PATH_MARKER.length, end).trim()
  return value.length > 0 && !value.includes("\n") ? value : undefined
}

export const mergePath = (loginPath: string | undefined, inherited: string | undefined): string => {
  const folders = [loginPath, inherited]
    .flatMap((path) => (path === undefined ? [] : path.split(delimiter)))
    .filter((folder) => folder.length > 0)
  return folders.length === 0 ? DEFAULT_PATH : [...new Set(folders)].join(delimiter)
}

export const readLoginShellPath = async (
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const shell = environment["SHELL"]
  if (shell === undefined || !isAbsolute(shell) || !KNOWN_SHELLS.has(basename(shell))) {
    return undefined
  }
  const result = await runBounded(
    shell,
    ["-ilc", `printf '${PATH_MARKER}'; /usr/bin/printenv PATH; printf '${PATH_MARKER}'`],
    environment,
    LOGIN_SHELL_TIMEOUT_MS
  )
  return result.kind === "exited" ? parseShellPath(result.output) : undefined
}

let resolving: Promise<string | undefined> | undefined
let resolved: string | undefined

export const resolveLoginShellPath = ({
  refresh = false
}: { readonly refresh?: boolean } = {}): Promise<string | undefined> => {
  if (resolving !== undefined && !refresh) return resolving
  const attempt = readLoginShellPath(process.env).then(
    (path) => {
      if (path !== undefined) resolved = path
      return resolved
    },
    () => resolved
  )
  resolving = attempt
  return attempt
}

export const resolvedLoginShellPath = (): string | undefined => resolved

export type ProbeResult =
  | { readonly kind: "exited"; readonly code: number; readonly output: string }
  | { readonly kind: "failed" }

export const runBounded = (
  file: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = []
    let size = 0
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(file, args, {
      env: withSafeGit(env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    })
    const timer = setTimeout(() => {
      signalProcessGroup(child.pid, "SIGKILL", (signal) => child.kill(signal))
      finish({ kind: "failed" })
    }, timeoutMs)
    const collect = (chunk: Buffer): void => {
      if (size >= MAX_OUTPUT_BYTES) return
      chunks.push(chunk)
      size += chunk.length
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.on("error", () => finish({ kind: "failed" }))
    child.on("close", (code) => {
      finish(
        code === null
          ? { kind: "failed" }
          : { kind: "exited", code, output: Buffer.concat(chunks).toString("utf8") }
      )
    })
  })
