import type { CliClient, CliDependencies } from "../src/index.js"
import type { AppLauncher } from "../src/app-launch.js"
import type { StartServer, StdinKind } from "../src/command.js"
import { defaultClient } from "./kit.js"

export interface TestIo {
  readonly dependencies: CliDependencies
  readonly stdout: () => string
  readonly stderr: () => string
  readonly sigint: () => void
  readonly connections: () => ReadonlyArray<{ readonly url: string; readonly headers: unknown }>
}

export const testIo = (
  input: {
    readonly client?: CliClient
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly stdin?: { readonly kind: StdinKind; readonly text: string }
    readonly files?: Readonly<Record<string, string>>
    readonly alive?: (pid: number) => boolean
    readonly launcher?: AppLauncher
  } = {}
): TestIo => {
  let stdout = ""
  let stderr = ""
  let sigintListener: (() => void) | undefined
  const connections: Array<{ readonly url: string; readonly headers: unknown }> = []
  const dependencies: CliDependencies = {
    env: input.env ?? {},
    homeDirectory: "/home/test",
    stdin: input.stdin?.kind ?? "terminal",
    readStdin: async () => input.stdin?.text ?? "",
    readFile: async (path) => {
      const text = input.files?.[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return Buffer.from(text)
    },
    isProcessAlive: input.alive ?? (() => true),
    appLauncher: input.launcher ?? NO_APP,
    writeStdout: (value) => {
      stdout += value
    },
    writeStderr: (value) => {
      stderr += value
    },
    onSigint: (listener) => {
      sigintListener = listener
      return () => {
        if (sigintListener === listener) sigintListener = undefined
      }
    },
    createClient: (connection) => {
      connections.push({ url: connection.url.href, headers: connection.headers })
      return input.client ?? defaultClient()
    }
  }
  return {
    dependencies,
    stdout: () => stdout,
    stderr: () => stderr,
    sigint: () => sigintListener?.(),
    connections: () => connections
  }
}

const NO_APP: AppLauncher = {
  find: async () => undefined,
  open: async () => {
    throw new Error("the tests never open an app")
  },
  pollMs: 1,
  timeoutMs: 20
}

export const URL_ARGS = ["--url", "http://arden.test"] as const

export const ASKED_AT = "2026-11-21T22:11:50.941Z"

export const CAPABILITY = "c".repeat(43)

export const started = (events: Array<string>): { readonly startServer: StartServer } => ({
  startServer: async (input: { readonly config: string; readonly logFile: string | undefined }) => {
    events.push(`start ${input.config} ${input.logFile ?? "-"}`)
    return {
      connection: {
        url: new URL("http://127.0.0.1:51234/"),
        headers: { "x-arden-local-capability": CAPABILITY }
      },
      stop: async () => {
        events.push("stop")
      }
    }
  }
})
