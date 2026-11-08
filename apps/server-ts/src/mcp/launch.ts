import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import type { McpStoredTransport } from "../persistence/mcp/store.js"
import { withSafeGit } from "../runtime/git-environment.js"
import { mergePath } from "../runtime/login-shell-path.js"
import { locateExecutable } from "../runtime/which.js"
import { McpStartFailure } from "./failure.js"

/**
 * The only variables a local server inherits from Arden: who and where the
 * person is, their locale and temp folder (npx and uv keep caches there), and
 * the CA bundles and the system-certificate switch a corporate proxy needs
 * (the desktop sets NODE_USE_SYSTEM_CA for the server). Never Arden's own settings or
 * provider keys. The server's saved environment comes on top.
 */
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

/** Keeps npm from printing update notices around a server's JSON-RPC stream. */
const QUIET_VARIABLES = { NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" } as const

type StdioTransport = Extract<McpStoredTransport, { readonly type: "stdio" }>

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
  if (!(await isFolder(cwd))) throw new McpStartFailure({ reason: "bad_folder", folder: cwd })
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

/**
 * The allowlisted variables, then the saved secrets, then a PATH that starts
 * with the program's own folder, so `npx`'s `#!/usr/bin/env node` finds the
 * Node it was installed with (nvm, volta, fnm, asdf).
 */
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
      ? { reason: "not_executable", path: resolved }
      : {
          reason: "command_not_found",
          command,
          pathSource: loginPath === undefined ? "process" : "login_shell"
        }
  )
}

const isFolder = (path: string): Promise<boolean> =>
  stat(path).then(
    (entry) => entry.isDirectory(),
    () => false
  )
