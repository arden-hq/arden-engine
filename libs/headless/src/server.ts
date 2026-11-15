import { daemonDecoders, LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { errorMessage } from "@arden-hq/std/errors"
import { isRecord } from "@arden-hq/std/json"
import { spawn, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"

/**
 * The one JSON line a configured server (`main.js --config <file>`) prints on
 * stdout once every setting is in place. The server writes it in
 * `apps/server-ts/src/serve/main.ts`; this is its reader's side.
 */
export interface ConfiguredServerReady {
  readonly url: string
  readonly dataDirectory: string
  /** Holds the server URL and the owner's secret (`cli-access.json`). */
  readonly accessFile: string
  /** The data folder's model requests and tokens, rewritten after every request. */
  readonly usageFile: string
  /** The tools the settings offer; undefined when they offer every tool. */
  readonly offeredTools: ReadonlyArray<string> | undefined
  /** Tools that always ask on a card, so the settings could give them no rule. */
  readonly toolsWithoutRule: ReadonlyArray<string>
  readonly mcpServers: ReadonlyArray<string>
}

/** Where a started server answers, with the secret every request carries. */
export interface ConfiguredServerConnection {
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
}

export interface ConfiguredServer {
  readonly ready: ConfiguredServerReady
  readonly connection: ConfiguredServerConnection
  /** Asks the server to stop (SIGTERM, SIGKILL after 10 s) and waits until it has. Never throws. */
  readonly stop: () => Promise<void>
}

/**
 * Why a configured server did not start. `settings`: the server exited with
 * code 2, its word for a settings file the caller can fix (a field, a missing
 * key variable, a model its provider does not list, a provider it could not
 * reach). `start`: anything else. The message is the server's own last
 * `arden:` line when it printed one.
 */
export class ConfiguredServerError extends Error {
  override readonly name = "ConfiguredServerError"

  constructor(
    readonly reason: "settings" | "start",
    message: string
  ) {
    super(message)
  }
}

export interface StartConfiguredServerOptions {
  /** The server's entry file (`@arden-hq/server`'s `dist/main.js`). */
  readonly entry: string
  /** The settings file (`apps/server-ts/src/serve/settings.ts` lists every field). */
  readonly config: string
  /** The server's whole environment: a provider's `apiKeyEnv` is read from it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Takes the server's log, which it writes to stderr; without it the log is dropped. */
  readonly onLog?: (chunk: string) => void
  /** Stops the start: the server is stopped and the start rejects with the signal's reason. */
  readonly signal?: AbortSignal
  /** The Node binary that runs the entry; default: this process's. */
  readonly execPath?: string
}

const STOP_TIMEOUT_MS = 10_000

/**
 * Start a configured server as a child process and wait for its ready line.
 * Every program that runs Arden from a settings file (the CLI's `serve` and
 * `exec`, the benchmark runner) starts it here, so each reads the same ready
 * line and reports the server's own reason when it does not start.
 */
export const startConfiguredServer = (
  options: StartConfiguredServerOptions
): Promise<ConfiguredServer> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      options.execPath ?? process.execPath,
      [options.entry, "--config", options.config],
      {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    const stop = () => stopChild(child)
    let lastWords = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      options.onLog?.(chunk)
      lastWords = (lastWords + chunk).slice(-4_000)
    })
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", onAbort)
      void stop().then(() => reject(error))
    }
    const onAbort = (): void => fail(options.signal?.reason)
    if (options.signal?.aborted === true) return fail(options.signal.reason)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    let pending = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (settled || pending.includes("\n")) return
      pending += chunk
      const end = pending.indexOf("\n")
      if (end === -1) return
      const ready = readyFrom(pending.slice(0, end))
      if (ready === undefined) {
        fail(new ConfiguredServerError("start", "The Arden server printed no ready line"))
        return
      }
      connectionOf(ready).then(
        (connection) => {
          if (settled) return
          settled = true
          options.signal?.removeEventListener("abort", onAbort)
          resolve({ ready, connection, stop })
        },
        (cause: unknown) => fail(new ConfiguredServerError("start", errorMessage(cause)))
      )
    })
    child.once("error", (cause) =>
      fail(new ConfiguredServerError("start", `Could not start the Arden server: ${cause.message}`))
    )
    child.once("exit", (code) => {
      const said = lastWords
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("arden: "))
        .at(-1)
      fail(
        new ConfiguredServerError(
          // Exit 2 is the server's own word for a settings mistake.
          code === 2 ? "settings" : "start",
          said?.slice("arden: ".length) ?? `The Arden server exited with code ${code}`
        )
      )
    })
  })

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

/** The server's own access file, read the way the CLI reads the app's. */
const connectionOf = async (ready: ConfiguredServerReady): Promise<ConfiguredServerConnection> => {
  const access = daemonDecoders.cliAccess(JSON.parse(await readFile(ready.accessFile, "utf8")))
  return { url: new URL(ready.url), headers: { [LOCAL_CAPABILITY_HEADER]: access.capability } }
}

const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const readyFrom = (line: string): ConfiguredServerReady | undefined => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value["type"] !== "ready") return undefined
  const { url, dataDirectory, accessFile, usageFile, offeredTools, toolsWithoutRule, mcpServers } =
    value
  if (
    typeof url !== "string" ||
    typeof dataDirectory !== "string" ||
    typeof accessFile !== "string" ||
    typeof usageFile !== "string" ||
    (offeredTools !== undefined && !isStrings(offeredTools)) ||
    !isStrings(toolsWithoutRule) ||
    !isStrings(mcpServers)
  )
    return undefined
  return {
    url,
    dataDirectory,
    accessFile,
    usageFile,
    offeredTools,
    toolsWithoutRule,
    mcpServers
  }
}
