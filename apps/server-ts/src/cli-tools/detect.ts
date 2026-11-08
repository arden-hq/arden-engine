import type { CliToolSignIn, CliToolsPathSource } from "@arden-hq/protocol/cli-tools"

import {
  mergePath,
  type ProbeResult,
  readLoginShellPath,
  resolveLoginShellPath,
  runBounded as run
} from "../runtime/login-shell-path.js"
import { locateExecutable } from "../runtime/which.js"
import { CLI_TOOLS, type CliToolEntry, parseVersion } from "./catalog.js"

interface DetectedCliTool {
  readonly entry: CliToolEntry
  readonly command: string
  readonly path: string
  readonly version: string | null
  readonly signIn: CliToolSignIn
}

export interface CliToolsDetection {
  readonly tools: ReadonlyArray<DetectedCliTool>
  readonly pathSource: CliToolsPathSource
}

export const detectCliTools = async ({
  environment,
  refreshPath = false
}: {
  readonly environment?: NodeJS.ProcessEnv
  readonly refreshPath?: boolean
} = {}): Promise<CliToolsDetection> => {
  const shellPath =
    environment === undefined
      ? await resolveLoginShellPath({ refresh: refreshPath })
      : await readLoginShellPath(environment)
  const inherited = environment ?? process.env
  const path = mergePath(shellPath, inherited["PATH"])
  const probeEnvironment: NodeJS.ProcessEnv = {
    ...inherited,
    PATH: path,
    NO_COLOR: "1",
    CI: "1",
    PAGER: "cat",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    NO_UPDATE_NOTIFIER: "1",
    CHECKPOINT_DISABLE: "1"
  }
  const found = await Promise.all(
    CLI_TOOLS.map(async (entry) => {
      const located = await locate(entry, path)
      return located === undefined ? [] : [{ entry, ...located }]
    })
  )
  const tools = await Promise.all(
    found.flat().map(async ({ entry, command, path: executable }) => {
      const [version, signIn] = await Promise.all([
        entry.version === undefined
          ? Promise.resolve(null)
          : run(executable, entry.version, probeEnvironment).then((result) =>
              result.kind === "exited" && result.code === 0 ? parseVersion(result.output) : null
            ),
        entry.signIn === undefined
          ? Promise.resolve<CliToolSignIn>("unknown")
          : run(executable, entry.signIn, probeEnvironment).then(signInState)
      ])
      return { entry, command, path: executable, version, signIn }
    })
  )
  return { tools, pathSource: shellPath === undefined ? "process" : "login_shell" }
}

const locate = async (
  entry: CliToolEntry,
  path: string
): Promise<{ readonly command: string; readonly path: string } | undefined> => {
  for (const command of entry.commands) {
    const located = await locateExecutable(command, path)
    if (located !== undefined) return { command, path: located }
  }
  return undefined
}

const signInState = (result: ProbeResult): CliToolSignIn => {
  if (result.kind !== "exited") return "unknown"
  return result.code === 0 ? "signed_in" : "signed_out"
}
