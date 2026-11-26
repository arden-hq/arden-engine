import { after } from "@arden-hq/std/timer"
import {
  CONFIGURED_SERVER_EXIT,
  daemonDecoders,
  LOCAL_CAPABILITY_HEADER,
  type ConfiguredServerReady
} from "@arden-hq/protocol/daemon"
import { errorMessage } from "@arden-hq/std/errors"
import { spawn, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"

export interface ConfiguredServerConnection {
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
}

export interface ConfiguredServer {
  readonly ready: ConfiguredServerReady
  readonly connection: ConfiguredServerConnection
  readonly stop: () => Promise<void>
  readonly exited: Promise<number | null>
}

export type { ConfiguredServerReady }

export class ConfiguredServerError extends Error {
  override readonly name = "ConfiguredServerError"

  constructor(
    readonly reason: "settings" | "provider" | "start",
    message: string
  ) {
    super(message)
  }
}

const reasonOf = (code: number | null): ConfiguredServerError["reason"] => {
  if (code === CONFIGURED_SERVER_EXIT.settings) return "settings"
  if (code === CONFIGURED_SERVER_EXIT.providerUnreachable) return "provider"
  return "start"
}

export interface StartConfiguredServerOptions {
  readonly entry: string
  readonly config: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly onLog?: (chunk: string) => void
  readonly signal?: AbortSignal
  readonly execPath?: string
}

const STOP_TIMEOUT_MS = 10_000

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
    const exited = new Promise<number | null>((resolveExit) => {
      child.once("exit", (code) => resolveExit(code))
    })
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
      if (settled || pending.includes("\n")) {
        options.onLog?.(chunk)
        return
      }
      pending += chunk
      const end = pending.indexOf("\n")
      if (end === -1) return
      const rest = pending.slice(end + 1)
      if (rest !== "") options.onLog?.(rest)
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
          resolve({ ready, connection, stop, exited })
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
          reasonOf(code),
          said?.slice("arden: ".length) ?? `The Arden server exited with code ${code}`
        )
      )
    })
  })

const stopChild = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const kill = after(STOP_TIMEOUT_MS, () => child.kill("SIGKILL"))
    child.once("exit", () => {
      kill.cancel()
      resolve()
    })
    child.kill("SIGTERM")
  })

const connectionOf = async (ready: ConfiguredServerReady): Promise<ConfiguredServerConnection> => {
  const access = daemonDecoders.cliAccessText(await readFile(ready.accessFile, "utf8"))
  return { url: new URL(ready.url), headers: { [LOCAL_CAPABILITY_HEADER]: access.capability } }
}

const readyFrom = (line: string): ConfiguredServerReady | undefined => {
  try {
    return daemonDecoders.configuredServerReadyText(line)
  } catch {
    return undefined
  }
}
