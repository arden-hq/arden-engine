import type { PendingChatGptLogin } from "@arden-hq/headless/chatgpt-login"
import {
  createHeadlessClient,
  type HeadlessHttpError,
  type ConfiguredServer,
  type ConfiguredServerConnection,
  type HeadlessClient
} from "@arden-hq/headless"
import { CLI_ACCESS_FILE, daemonDecoders, LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { ARDEN_DIR_VARIABLE, ardenCliDir, resolveArdenDir } from "@arden-hq/std/paths"
import { sleep } from "@arden-hq/std/sleep"
import { join } from "node:path"

import type { AppLauncher } from "./app-launch.js"

export type CliClient = Pick<
  HeadlessClient,
  | "answerApproval"
  | "answerConnection"
  | "answerQuestion"
  | "branchSession"
  | "cancel"
  | "createSession"
  | "deleteSession"
  | "health"
  | "listModels"
  | "listSpaces"
  | "listSessions"
  | "submit"
  | "wait"
  | "waitForRun"
>

interface StartServerInput {
  readonly config: string
  /** A file that takes the server's log lines; without it they are dropped. */
  readonly logFile: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
}

export type StartServer = (
  input: StartServerInput
) => Promise<Pick<ConfiguredServer, "connection" | "stop">>

export type StdinKind = "terminal" | "pipe" | "file" | "other"

export type ServerConnection = ConfiguredServerConnection

export interface CliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homeDirectory: string
  readonly stdin: StdinKind
  readonly readStdin: () => Promise<string>
  readonly readFile: (path: string) => Promise<Uint8Array>
  readonly isProcessAlive: (pid: number) => boolean
  readonly writeStdout: (value: string) => void
  readonly writeStderr: (value: string) => void
  readonly onSigint: (listener: () => void) => () => void
  readonly createClient?: (connection: ServerConnection) => CliClient
  /** Where the server is, for a command that brings its own (`arden exec`);
   *  it replaces the lookup by --url, ARDEN_URL and the access file. */
  readonly connect?: (() => Promise<ServerConnection>) | undefined
  /** Starts the configured server for `arden exec`; the default spawns it. */
  readonly startServer?: StartServer
  readonly startLogin?: () => Promise<PendingChatGptLogin>
  readonly openUrl?: (url: string) => void
  readonly appLauncher: AppLauncher
  readonly askInTerminal?: ((prompt: string) => Promise<string | undefined>) | undefined
}

export class UsageError extends Error {
  override readonly name = "UsageError"
}

export class NoModelError extends Error {
  override readonly name = "NoModelError"
}

export class OlderServerError extends Error {
  override readonly name = "OlderServerError"
  constructor() {
    super("This Arden is older than the CLI. Update Arden, or add --mode ask.")
  }
}

export const plainHttpMessage = (cause: HeadlessHttpError): string => {
  const detail = detailOf(cause.detail)
  if (detail !== undefined) return detail
  if (cause.status === 401 || cause.status === 403)
    return "Arden does not let the command line do this."
  if (cause.status === 404) return "Arden has no such chat, Run or question."
  if (cause.status === 409)
    return "Arden cannot do this right now; the chat is busy or already moved on."
  if (cause.status >= 500) return "Arden hit an error. Try again, or look at its log."
  return "Arden could not do this."
}

const detailOf = (text: string): string | undefined => {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body !== "object" || body === null || !("detail" in body)) return undefined
    return typeof body.detail === "string" && body.detail.length > 0 ? body.detail : undefined
  } catch {
    return undefined
  }
}

export class ServerUnavailableError extends Error {
  override readonly name = "ServerUnavailableError"
}

/** The model server a configured server needs did not answer when it started. */
export class ProviderUnavailableError extends Error {
  override readonly name = "ProviderUnavailableError"
}

export const createCliClient = (
  dependencies: CliDependencies,
  connection: ServerConnection
): CliClient =>
  dependencies.createClient?.(connection) ??
  createHeadlessClient({ baseUrl: connection.url, headers: connection.headers })

export const valueAfter = (
  args: ReadonlyArray<string>,
  index: number,
  name: string,
  inline: string | undefined
): { readonly value: string; readonly nextIndex: number } => {
  const value = inline ?? args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} requires a value`)
  }
  return { value, nextIndex: inline === undefined ? index + 1 : index }
}

export const timeoutMilliseconds = (value: string): number => {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError("--timeout must be a positive number of seconds")
  }
  const milliseconds = Math.ceil(seconds * 1_000)
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new UsageError("--timeout is too large")
  }
  return milliseconds
}

const parseServerUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError("Arden server URL is invalid")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("Arden server URL must use http or https")
  }
  return url
}

const NOT_RUNNING =
  "Arden is not running. Open Arden, start `arden serve`, or set --url (or ARDEN_URL) to a server, or ARDEN_DIR to the data folder of an `arden serve`."

export const resolveServer = async (
  argument: string | undefined,
  dependencies: CliDependencies
): Promise<ServerConnection> => {
  if (dependencies.connect !== undefined) return dependencies.connect()
  const explicit = argument?.trim() || dependencies.env["ARDEN_URL"]?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    return { url: parseServerUrl(explicit), headers: {} }
  }
  const found = await findServer(dependencies)
  switch (found.kind) {
    case "found":
      return found.connection
    case "none":
      throw new ServerUnavailableError(NOT_RUNNING)
    case "too_old":
      throw new ServerUnavailableError(TOO_OLD_TO_START)
  }
}

export type FoundServer =
  | { readonly kind: "found"; readonly connection: ServerConnection }
  | { readonly kind: "none" }
  | { readonly kind: "too_old" }

const TOO_OLD_TO_START =
  "Arden is not running, and the installed Arden is too old to start from the command line. Open Arden, or update it."

export const TOO_OLD_FOR_PROMPT =
  "The installed Arden is too old to start in the background; this prompt runs on a server of its own, without your accounts."

export const findServer = async (dependencies: CliDependencies): Promise<FoundServer> => {
  const local = await findLocalServer(dependencies)
  if (local !== undefined) return { kind: "found", connection: local }
  if ((dependencies.env[ARDEN_DIR_VARIABLE]?.trim() ?? "") !== "") return { kind: "none" }
  const app = await dependencies.appLauncher.find()
  if (app === undefined) return { kind: "none" }
  if (app.kind === "too_old") return { kind: "too_old" }
  return { kind: "found", connection: await startAppInBackground(app.path, dependencies) }
}

const startAppInBackground = async (
  appPath: string,
  dependencies: CliDependencies
): Promise<ServerConnection> => {
  const launcher = dependencies.appLauncher
  const folder = resolveArdenDir(dependencies.env, dependencies.homeDirectory)
  const stale = await accessIn(folder, dependencies).catch(() => undefined)
  dependencies.writeStderr("arden: Arden is not running; starting it in the background.\n")
  await launcher.open(appPath)
  for (let waited = 0; waited < launcher.timeoutMs; waited += launcher.pollMs) {
    const access = await accessIn(folder, dependencies).catch(() => undefined)
    if (
      access !== undefined &&
      access.pid !== stale?.pid &&
      dependencies.isProcessAlive(access.pid)
    ) {
      return connectionOf(access)
    }
    await sleep(launcher.pollMs)
  }
  throw new ServerUnavailableError(
    `Arden did not start within ${Math.round(launcher.timeoutMs / 1_000)} s: ${join(folder, CLI_ACCESS_FILE)} names no running server`
  )
}

const findLocalServer = async (
  dependencies: CliDependencies
): Promise<ServerConnection | undefined> => {
  const app = resolveArdenDir(dependencies.env, dependencies.homeDirectory)
  const folders =
    (dependencies.env[ARDEN_DIR_VARIABLE]?.trim() ?? "") === ""
      ? [app, join(ardenCliDir(dependencies.homeDirectory), "data")]
      : [app]
  for (const folder of folders) {
    const found = await serverIn(folder, dependencies)
    if (found !== undefined) return found
  }
  return undefined
}

const serverIn = async (
  folder: string,
  dependencies: CliDependencies
): Promise<ServerConnection | undefined> => {
  const access = await accessIn(folder, dependencies)
  if (access === undefined || !dependencies.isProcessAlive(access.pid)) return undefined
  return connectionOf(access)
}

type CliAccess = ReturnType<typeof daemonDecoders.cliAccess>

const accessIn = async (
  folder: string,
  dependencies: CliDependencies
): Promise<CliAccess | undefined> => {
  const path = join(folder, CLI_ACCESS_FILE)
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readFile(path)
  } catch {
    return undefined
  }
  try {
    return daemonDecoders.cliAccess(JSON.parse(Buffer.from(bytes).toString("utf8")))
  } catch {
    throw new ServerUnavailableError(`Arden's access file is unreadable: ${path}`)
  }
}

const connectionOf = (access: CliAccess): ServerConnection => ({
  url: parseServerUrl(access.serverUrl),
  headers: { [LOCAL_CAPABILITY_HEADER]: access.capability }
})
