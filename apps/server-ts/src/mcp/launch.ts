import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { CLI_TOOLS_PATH_SOURCE } from "@arden-hq/protocol/cli-tools"
import { MCP_TRANSPORT } from "@arden-hq/protocol/mcp"

import type { McpStoredTransport } from "../persistence/mcp/store.js"
import { withSafeGit } from "../runtime/git-environment.js"
import { mergePath } from "../runtime/login-shell-path.js"
import { locateExecutable } from "../runtime/which.js"
import { MCP_FAILURE_REASON, McpStartFailure } from "./failure.js"

const INHERITED_VARIABLES = [
  "HOME",
  "LOGNAME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA"
] as const

const QUIET_VARIABLES: McpStdioLaunch["environment"] = {
  NO_UPDATE_NOTIFIER: "1",
  npm_config_update_notifier: "false"
}

type StdioTransport = Extract<McpStoredTransport, { readonly type: typeof MCP_TRANSPORT.stdio }>

export interface McpStdioLaunch {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly secretValues: ReadonlyArray<string>
}

export const prepareMcpStdioLaunch = async ({
  transport,
  secrets,
  loginPath,
  inherited = process.env,
  home = homedir()
}: {
  readonly transport: StdioTransport
  readonly secrets: Readonly<Record<string, string>>
  readonly loginPath: string | undefined
  readonly inherited?: NodeJS.ProcessEnv
  readonly home?: string
}): Promise<McpStdioLaunch> => {
  const cwd = transport.cwd ?? home
  if (!(await isFolder(cwd)))
    throw new McpStartFailure({ reason: MCP_FAILURE_REASON.badFolder, folder: cwd })
  const searchPath = secrets["PATH"] ?? mergePath(loginPath, inherited["PATH"])
  const command = transport.command.includes("/")
    ? resolve(cwd, transport.command)
    : transport.command
  const executable = await locateExecutable(command, searchPath)
  if (executable === undefined) throw await missingCommand(command, transport.command, loginPath)
  return {
    executable,
    args: transport.args,
    cwd,
    environment: mcpStdioEnvironment({ inherited, searchPath, executable, secrets }),
    secretValues: Object.values(secrets)
  }
}

const mcpStdioEnvironment = ({
  inherited,
  searchPath,
  executable,
  secrets
}: {
  readonly inherited: NodeJS.ProcessEnv
  readonly searchPath: string
  readonly executable: string
  readonly secrets: Readonly<Record<string, string>>
}): Readonly<Record<string, string>> =>
  withSafeGit({
    ...Object.fromEntries(
      INHERITED_VARIABLES.flatMap((name) => {
        const value = inherited[name]
        return value === undefined ? [] : [[name, value]]
      })
    ),
    ...QUIET_VARIABLES,
    ...secrets,
    PATH: mergePath(dirname(executable), searchPath)
  })

const missingCommand = async (
  resolved: string,
  command: string,
  loginPath: string | undefined
): Promise<McpStartFailure> => {
  const exists = command.includes("/")
    ? await access(resolved).then(
        () => true,
        () => false
      )
    : false
  return new McpStartFailure(
    exists
      ? { reason: MCP_FAILURE_REASON.notExecutable, path: resolved }
      : {
          reason: MCP_FAILURE_REASON.commandNotFound,
          command,
          pathSource:
            loginPath === undefined
              ? CLI_TOOLS_PATH_SOURCE.process
              : CLI_TOOLS_PATH_SOURCE.loginShell
        }
  )
}

const isFolder = (path: string): Promise<boolean> =>
  stat(path).then(
    (entry) => entry.isDirectory(),
    () => false
  )
