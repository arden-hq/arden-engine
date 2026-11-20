import {
  ConfiguredServerError,
  startConfiguredServer,
  type ConfiguredServer
} from "@arden-hq/headless"
import { errorMessage } from "@arden-hq/std/errors"
import { ardenCliDir } from "@arden-hq/std/paths"
import { spawn } from "node:child_process"
import { createWriteStream, existsSync, type WriteStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  findServer,
  ProviderUnavailableError,
  ServerUnavailableError,
  UsageError,
  type CliDependencies,
  type ServerConnection,
  type StartServer
} from "./command.js"
import { failureOf, runCommand, type RunOptions } from "./run.js"

const NOT_INSTALLED =
  "The Arden server is not installed beside this command. Install @arden-hq/server, or set ARDEN_SERVER_ENTRY to its dist/main.js."

/**
 * The server's entry file. The command line does not contain the server: it
 * starts the one named by ARDEN_SERVER_ENTRY, else the installed
 * @arden-hq/server, else the one that sits beside it in Arden's own checkout.
 */
const serverEntry = (env: Readonly<Record<string, string | undefined>>): string => {
  const explicit = env["ARDEN_SERVER_ENTRY"]?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  try {
    return fileURLToPath(import.meta.resolve("@arden-hq/server/main"))
  } catch {
    const sibling = fileURLToPath(new URL("../../server-ts/dist/main.js", import.meta.url))
    if (existsSync(sibling)) return sibling
    throw new ServerUnavailableError(NOT_INSTALLED)
  }
}

/**
 * Starts a configured server as a child process and waits for its ready line.
 * A start that fails rejects with the server's own last words: its `arden:`
 * line names the settings mistake (exit 2) or the model server that did not
 * answer (exit 3).
 */
const startServer: StartServer = async ({ config, logFile, env }) => {
  const log = logFile === undefined ? undefined : createWriteStream(logFile, { flags: "a" })
  try {
    const server = await startConfiguredServer({
      entry: serverEntry(env),
      config,
      env,
      ...(log === undefined ? {} : { onLog: (chunk: string) => log.write(chunk) })
    })
    return {
      connection: server.connection,
      stop: async () => {
        await server.stop()
        log?.end()
      }
    }
  } catch (cause) {
    log?.end()
    throw startFailure(cause)
  }
}

const startFailure = (cause: unknown): unknown => {
  if (!(cause instanceof ConfiguredServerError)) return cause
  switch (cause.reason) {
    case "settings":
      return new UsageError(cause.message)
    case "provider":
      return new ProviderUnavailableError(cause.message)
    case "start":
      return new ServerUnavailableError(cause.message)
  }
}

const settingsFile = async (config: string | undefined, home: string): Promise<string> => {
  if (config !== undefined) return config
  const folder = ardenCliDir(home)
  const file = join(folder, "settings.json")
  if (existsSync(file)) return file
  const settings = { dataDirectory: join(folder, "data") }
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx" })
  } catch (cause) {
    throw new UsageError(`Cannot write the default settings file ${file}: ${errorMessage(cause)}`)
  }
  return file
}

export interface ServeOptions {
  readonly config: string | undefined
  readonly verbose: boolean
}

export const serveCommand = async (
  options: ServeOptions,
  dependencies: CliDependencies
): Promise<number> => {
  let entry: string
  let config: string
  try {
    entry = serverEntry(dependencies.env)
    config = await settingsFile(options.config, dependencies.homeDirectory)
  } catch (cause) {
    dependencies.writeStderr(`arden: ${errorMessage(cause)}\n`)
    return cause instanceof UsageError ? 2 : 1
  }
  return options.verbose
    ? serveInForeground(entry, config, dependencies)
    : serveQuietly(entry, config, dependencies)
}

const serveQuietly = async (
  entry: string,
  config: string,
  dependencies: CliDependencies
): Promise<number> => {
  let early = ""
  let log: WriteStream | undefined
  const onLog = (chunk: string): void => {
    if (log === undefined) early += chunk
    else log.write(chunk)
  }
  let server: ConfiguredServer
  try {
    server = await startConfiguredServer({ entry, config, env: dependencies.env, onLog })
  } catch (cause) {
    const failure = startFailure(cause)
    dependencies.writeStderr(`arden: ${errorMessage(failure)}\n`)
    return failureOf(failure).exitCode
  }
  const logFile = join(server.ready.dataDirectory, SERVER_LOG_FILE)
  log = createWriteStream(logFile, { flags: "a" })
  log.write(early)
  dependencies.writeStdout(
    `Arden is running at ${server.ready.url}. Send prompts from another terminal: arden "…"\nIts log goes to ${logFile}. Ctrl-C stops it.\n`
  )
  let stopping = false
  const stopped = new Promise<"stopped">((resolve) => {
    const stop = (): void => {
      stopping = true
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
      void server.stop().then(() => resolve("stopped"))
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  const outcome = await Promise.race([stopped, server.exited])
  log.end()
  if (outcome === "stopped" || stopping) return 0
  dependencies.writeStderr(`arden: The Arden server stopped (exit ${outcome}); see ${logFile}\n`)
  return outcome === null || outcome === 0 ? 1 : outcome
}

const SERVER_LOG_FILE = "server.log"

const serveInForeground = (
  entry: string,
  config: string,
  dependencies: CliDependencies
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, "--config", config], {
      env: dependencies.env,
      stdio: "inherit"
    })
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
    const onInt = forward("SIGINT")
    const onTerm = forward("SIGTERM")
    process.on("SIGINT", onInt)
    process.on("SIGTERM", onTerm)
    const done = (code: number): void => {
      process.removeListener("SIGINT", onInt)
      process.removeListener("SIGTERM", onTerm)
      resolve(code)
    }
    child.once("error", (cause) => {
      dependencies.writeStderr(`arden: Could not start the Arden server: ${cause.message}\n`)
      done(1)
    })
    child.once("exit", (code) => done(code ?? 1))
  })

export interface ExecOptions {
  readonly config: string | undefined
  readonly logFile: string | undefined
  readonly run: RunOptions
}

/**
 * `arden exec`: start a configured server, run one prompt on it as `arden run`
 * does, and stop the server. The server starts only once the prompt and its
 * files are known to be valid, and stops whatever the Run's outcome.
 */
export const execCommand = async (
  options: ExecOptions,
  dependencies: CliDependencies
): Promise<number> => {
  let server: Awaited<ReturnType<StartServer>> | undefined
  const connect = async () => {
    server = await (dependencies.startServer ?? startServer)({
      config: await settingsFile(options.config, dependencies.homeDirectory),
      logFile: options.logFile,
      env: dependencies.env
    })
    return server.connection
  }
  try {
    const run: RunOptions =
      dependencies.askInTerminal === undefined
        ? { ...options.run, approvals: "decline" }
        : options.run
    return await runCommand(run, { ...dependencies, connect })
  } finally {
    await server?.stop()
  }
}

export const promptCommand = async (
  options: RunOptions,
  dependencies: CliDependencies
): Promise<number> => {
  if (options.urlArgument !== undefined || (dependencies.env["ARDEN_URL"]?.trim() ?? "") !== "")
    return runCommand(options, dependencies)
  let found: ServerConnection | undefined
  try {
    found = await findServer(dependencies)
  } catch {
    return runCommand(options, dependencies)
  }
  if (found !== undefined) {
    const connection = found
    return runCommand(options, { ...dependencies, connect: async () => connection })
  }
  if (options.detach) {
    return runCommand(options, {
      ...dependencies,
      connect: () => Promise.reject(new UsageError(DETACH_NEEDS_SERVER))
    })
  }
  return execCommand({ config: undefined, logFile: undefined, run: options }, dependencies)
}

const DETACH_NEEDS_SERVER =
  "--detach leaves the Run going on a server, and none is running: start `arden serve` first"
