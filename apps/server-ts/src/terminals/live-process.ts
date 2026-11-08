import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { join } from "node:path"

import type { ShellInvocation } from "../tools/shell-policy.js"
import { canDetach, signalProcessGroup, terminate } from "@arden-hq/std/process"

export type OutputStream = "stdout" | "stderr"

export type ProcessExit =
  | { readonly kind: "code"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: string }

export type ProcessInput = "closed" | "pipe"

export interface LiveProcess {
  readonly pid: number | undefined
  readonly input: ProcessInput
  readonly onData: (listener: (stream: OutputStream, chunk: Buffer) => void) => () => void
  readonly onExit: (listener: (exit: ProcessExit) => void) => () => void
  readonly onSpawnError: (listener: (cause: Error) => void) => () => void
  readonly exit: () => ProcessExit | undefined
  readonly write: (data: string) => boolean
  readonly interrupt: () => void
  readonly kill: () => void
}

export const spawnLiveProcess = (
  invocation: ShellInvocation,
  { input }: { readonly input: ProcessInput }
): LiveProcess => {
  const pty = input === "pipe" ? loadPty() : undefined
  if (pty !== undefined) {
    try {
      return spawnPtyProcess(pty, invocation)
    } catch {}
  }
  return spawnPipeProcess(invocation, input)
}

interface Listeners {
  readonly data: Set<(stream: OutputStream, chunk: Buffer) => void>
  readonly exit: Set<(exit: ProcessExit) => void>
  readonly error: Set<(cause: Error) => void>
  ended: ProcessExit | undefined
}

const makeListeners = (): Listeners => ({
  data: new Set(),
  exit: new Set(),
  error: new Set(),
  ended: undefined
})

const settle = (listeners: Listeners, exit: ProcessExit): void => {
  if (listeners.ended !== undefined) return
  listeners.ended = exit
  for (const listener of [...listeners.exit]) listener(exit)
  listeners.exit.clear()
}

const subscriptions = (
  listeners: Listeners
): Pick<LiveProcess, "onData" | "onExit" | "onSpawnError" | "exit"> => ({
  onData: (listener) => {
    listeners.data.add(listener)
    return () => listeners.data.delete(listener)
  },
  onExit: (listener) => {
    if (listeners.ended !== undefined) {
      listener(listeners.ended)
      return () => undefined
    }
    listeners.exit.add(listener)
    return () => listeners.exit.delete(listener)
  },
  onSpawnError: (listener) => {
    listeners.error.add(listener)
    return () => listeners.error.delete(listener)
  },
  exit: () => listeners.ended
})

const spawnPipeProcess = (invocation: ShellInvocation, input: ProcessInput): LiveProcess => {
  const child = spawn(invocation.executable, [...invocation.args], {
    cwd: invocation.cwd,
    detached: canDetach,
    env: invocation.env,
    stdio: [input === "pipe" ? "pipe" : "ignore", "pipe", "pipe"]
  })
  const listeners = makeListeners()
  let spawned = false
  child.once("spawn", () => {
    spawned = true
  })
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const listener of [...listeners.data]) listener("stdout", chunk)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const listener of [...listeners.data]) listener("stderr", chunk)
  })
  // A process that exits while a writer still holds stdin raises EPIPE here.
  child.stdin?.on("error", () => undefined)
  child.once("error", (cause) => {
    if (!spawned) {
      for (const listener of [...listeners.error]) listener(cause)
      listeners.error.clear()
    }
    settle(listeners, { kind: "signal", signal: "error" })
  })
  child.once("close", (code, signal) =>
    settle(
      listeners,
      signal !== null || code === null
        ? { kind: "signal", signal: signal ?? "unknown" }
        : { kind: "code", code }
    )
  )
  const toGroup = (signal: NodeJS.Signals): void => {
    if (listeners.ended === undefined) signalProcessGroup(child.pid, signal, (s) => child.kill(s))
  }
  return {
    pid: child.pid,
    input,
    ...subscriptions(listeners),
    write: (data) => {
      const stdin = child.stdin
      if (stdin === null || stdin.destroyed || listeners.ended !== undefined) return false
      stdin.write(data)
      return true
    },
    interrupt: () => toGroup("SIGINT"),
    kill: () =>
      terminate(
        (signal) => signalProcessGroup(child.pid, signal, (s) => child.kill(s)),
        () => listeners.ended !== undefined
      )
  }
}

const spawnPtyProcess = (pty: PtyModule, invocation: ShellInvocation): LiveProcess => {
  const terminal = pty.spawn(invocation.executable, [...invocation.args], {
    name: invocation.env["TERM"] ?? "dumb",
    cwd: invocation.cwd,
    env: invocation.env,
    cols: 120,
    rows: 30
  })
  const listeners = makeListeners()
  terminal.onData((data) => {
    const chunk = Buffer.from(data.replaceAll("\r\n", "\n"))
    for (const listener of [...listeners.data]) listener("stdout", chunk)
  })
  terminal.onExit(({ exitCode, signal }) =>
    settle(
      listeners,
      signal !== undefined && signal > 0
        ? { kind: "signal", signal: signalName(signal) }
        : { kind: "code", code: exitCode }
    )
  )
  return {
    pid: terminal.pid,
    input: "pipe",
    ...subscriptions(listeners),
    write: (data) => {
      if (listeners.ended !== undefined) return false
      terminal.write(data)
      return true
    },
    interrupt: () => {
      if (listeners.ended === undefined) terminal.write("\u0003")
    },
    kill: () =>
      terminate(
        (signal) => signalProcessGroup(terminal.pid, signal, (s) => terminal.kill(s)),
        () => listeners.ended !== undefined
      )
  }
}

const signalName = (signal: number): string =>
  Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] ?? `signal ${signal}`

type PtyModule = typeof import("node-pty")

let ptyModule: PtyModule | null | undefined

/**
 * node-pty stays outside the server bundle: development resolves the
 * workspace copy, a packaged app the one unpacked beside Electron's asar.
 * Without either, commands with open input run on a pipe.
 */
const loadPty = (): PtyModule | undefined => {
  if (ptyModule !== undefined) return ptyModule ?? undefined
  const require = createRequire(import.meta.url)
  const resources = (process as { readonly resourcesPath?: string }).resourcesPath
  const candidates = [
    PTY_MODULE,
    ...(resources === undefined
      ? []
      : [join(resources, "app.asar.unpacked", "node_modules", PTY_MODULE)])
  ]
  for (const candidate of candidates) {
    try {
      ptyModule = require(candidate) as PtyModule
      return ptyModule
    } catch {}
  }
  ptyModule = null
  return undefined
}

const PTY_MODULE = ["node", "pty"].join("-")
