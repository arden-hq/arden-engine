import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { errorMessage } from "@arden-hq/std/errors"

import {
  resolveServer,
  ServerUnavailableError,
  UsageError,
  type CliDependencies,
  type ServerReady,
  type StartedServer,
  type StartServer
} from "./command.js"
import { runCommand, type RunOptions } from "./run.js"

const NOT_INSTALLED =
  "The Arden server is not installed beside this command. Install @arden-hq/server, or set ARDEN_SERVER_ENTRY to its dist/main.js."

/**
 * The server's entry file. The command line does not contain the server: it
 * starts the one named by ARDEN_SERVER_ENTRY, else the installed
 * @arden-hq/server, else the one that sits beside it in Arden's own checkout.
 */
export const serverEntry = (env: Readonly<Record<string, string | undefined>>): string => {
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

const STOP_TIMEOUT_MS = 10_000

const stopChild = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const kill = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS)
    child.once("exit", () => {
      clearTimeout(kill)
      resolve()
    })
    child.kill("SIGTERM")
  })

const readyFrom = (line: string): ServerReady | undefined => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { type, url, dataDirectory, accessFile } = value as Record<string, unknown>
  return type === "ready" &&
    typeof url === "string" &&
    typeof dataDirectory === "string" &&
    typeof accessFile === "string"
    ? { url, dataDirectory, accessFile }
    : undefined
}

/**
 * Starts a configured server as a child process and waits for its ready line.
 * A start that fails rejects with the server's own last words: its `arden:`
 * line names the settings mistake.
 */
export const startServer: StartServer = ({ config, logFile, env }) =>
  new Promise((resolve, reject) => {
    const entry = serverEntry(env)
    const child = spawn(process.execPath, [entry, "--config", config], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    const log = logFile === undefined ? undefined : createWriteStream(logFile, { flags: "a" })
    let lastWords = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      log?.write(chunk)
      lastWords = (lastWords + chunk).slice(-4_000)
    })
    let pending = ""
    let settled = false
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (settled) return
      pending += chunk
      const end = pending.indexOf("\n")
      if (end === -1) return
      const ready = readyFrom(pending.slice(0, end))
      settled = true
      if (ready === undefined) {
        void stopChild(child)
        reject(new ServerUnavailableError("The Arden server printed no ready line"))
        return
      }
      resolve({
        ready,
        stop: async () => {
          await stopChild(child)
          log?.end()
        }
      })
    })
    child.once("error", (cause) => {
      if (settled) return
      settled = true
      reject(new ServerUnavailableError(`Could not start the Arden server: ${cause.message}`))
    })
    child.once("exit", (code) => {
      log?.end()
      if (settled) return
      settled = true
      const said = lastWords
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("arden: "))
        .at(-1)
      const message = said?.slice("arden: ".length) ?? `The Arden server exited with code ${code}`
      // Exit 2 is the server's own word for a settings mistake.
      reject(code === 2 ? new UsageError(message) : new ServerUnavailableError(message))
    })
  })

export interface ServeOptions {
  readonly config: string
}

/**
 * `arden serve`: the configured server in the foreground. Its ready line goes
 * to stdout and its log to stderr, untouched; Ctrl-C or SIGTERM stops it.
 */
export const serveCommand = (
  options: ServeOptions,
  dependencies: CliDependencies
): Promise<number> =>
  new Promise((resolve) => {
    let entry: string
    try {
      entry = serverEntry(dependencies.env)
    } catch (cause) {
      dependencies.writeStderr(`arden: ${errorMessage(cause)}\n`)
      return resolve(1)
    }
    const child = spawn(process.execPath, [entry, "--config", options.config], {
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
  readonly config: string
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
  let server: StartedServer | undefined
  const connect = async () => {
    server = await (dependencies.startServer ?? startServer)({
      config: options.config,
      logFile: options.logFile,
      env: dependencies.env
    })
    // The server's own access file, read the way `arden run` reads the app's.
    return resolveServer(undefined, {
      ...dependencies,
      connect: undefined,
      env: { ARDEN_DIR: server.ready.dataDirectory }
    })
  }
  try {
    return await runCommand(options.run, { ...dependencies, connect })
  } finally {
    await server?.stop()
  }
}
