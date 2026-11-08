import { createHeadlessClient, type HeadlessClient } from "@arden-hq/headless"
import { CLI_ACCESS_FILE, daemonDecoders, LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { resolveArdenDir } from "@arden-hq/std/paths"
import { join } from "node:path"

export type CliClient = Pick<
  HeadlessClient,
  | "answerApproval"
  | "answerConnection"
  | "branchSession"
  | "cancel"
  | "createSession"
  | "deleteSession"
  | "health"
  | "listSpaces"
  | "listSessions"
  | "submit"
  | "wait"
  | "waitForRun"
>

export type StdinKind = "terminal" | "pipe" | "file" | "other"

export interface ServerConnection {
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
}

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
}

export class UsageError extends Error {
  override readonly name = "UsageError"
}

export class NoModelError extends Error {
  override readonly name = "NoModelError"
}

export class ServerUnavailableError extends Error {
  override readonly name = "ServerUnavailableError"
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

const NOT_RUNNING = "Arden is not running. Open Arden, or set --url (or ARDEN_URL) to a server."

export const resolveServer = async (
  argument: string | undefined,
  dependencies: CliDependencies
): Promise<ServerConnection> => {
  const explicit = argument?.trim() || dependencies.env["ARDEN_URL"]?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    return { url: parseServerUrl(explicit), headers: {} }
  }
  const path = join(resolveArdenDir(dependencies.env, dependencies.homeDirectory), CLI_ACCESS_FILE)
  let bytes: Uint8Array
  try {
    bytes = await dependencies.readFile(path)
  } catch {
    throw new ServerUnavailableError(NOT_RUNNING)
  }
  let access: ReturnType<typeof daemonDecoders.cliAccess>
  try {
    access = daemonDecoders.cliAccess(JSON.parse(Buffer.from(bytes).toString("utf8")))
  } catch {
    throw new ServerUnavailableError(`Arden's access file is unreadable: ${path}`)
  }
  if (!dependencies.isProcessAlive(access.pid)) throw new ServerUnavailableError(NOT_RUNNING)
  return {
    url: parseServerUrl(access.serverUrl),
    headers: { [LOCAL_CAPABILITY_HEADER]: access.capability }
  }
}
