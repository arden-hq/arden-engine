import { StringDecoder } from "node:string_decoder"

import type { LiveProcess, OutputStream, ProcessExit, ProcessInput } from "./live-process.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"

import type { ShellAccess } from "../tools/shell-policy.js"
import { currentMillis } from "../runtime/clock.js"

const MAX_REPLAY_CHARS = 512 * 1024
const MAX_READ_CHARS = 64 * 1024
const MAX_DETACHED = 16

type TerminalPhase = "foreground" | "detached"

export interface TerminalInfo {
  readonly id: number
  readonly sessionId: string
  readonly runId: string
  readonly toolCallId: string
  readonly command: string
  readonly cwd: string
  readonly access: ShellAccess
  readonly approvalMode: ChatApprovalMode
  readonly pid: number | undefined
  readonly input: ProcessInput
  readonly startedAt: number
  readonly phase: TerminalPhase
  readonly exit: ProcessExit | undefined
  readonly endedAt: number | undefined
}

interface TerminalRead {
  readonly output: string
  readonly omitted: number
  readonly exit: ProcessExit | undefined
}

type TerminalEvent =
  | {
      readonly type: "output"
      readonly terminal: TerminalInfo
      readonly data: string
      readonly cursor: number
    }
  | { readonly type: "state"; readonly terminal: TerminalInfo }
  | { readonly type: "removed"; readonly terminal: TerminalInfo }

type TerminalWrite = "sent" | "stdin_closed" | "exited"

interface Entry {
  info: TerminalInfo
  readonly process: LiveProcess
  replay: string
  cursor: number
  readCursor: number
  readonly readerCursors: Map<string, number>
  exitNotice: "pending" | "done"
  readonly detach: () => void
}

export interface ExitNotice {
  readonly terminal: TerminalInfo
  readonly tail: string
}

const NOTICE_TAIL_CHARS = 4_000

export interface TerminalStore {
  readonly start: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
    readonly command: string
    readonly cwd: string
    readonly access: ShellAccess
    readonly approvalMode: ChatApprovalMode
    readonly process: LiveProcess
  }) => TerminalInfo
  readonly release: (id: number) => void
  readonly detach: (id: number) => TerminalInfo | undefined
  readonly get: (id: number) => TerminalInfo | undefined
  readonly all: () => ReadonlyArray<TerminalInfo>
  readonly list: (sessionId: string) => ReadonlyArray<TerminalInfo>
  readonly replay: (id: number) => { readonly output: string; readonly cursor: number } | undefined
  readonly read: (id: number, readerId?: string) => TerminalRead | undefined
  readonly wait: (
    id: number,
    options: { readonly ms: number; readonly signal: AbortSignal }
  ) => Promise<void>
  readonly write: (id: number, chars: string) => TerminalWrite
  readonly kill: (id: number, options?: { readonly notify: boolean }) => void
  readonly stopRuns: (runIds: ReadonlyArray<string>) => void
  readonly remove: (id: number) => void
  readonly peekExitNotice: (id: number) => ExitNotice | undefined
  readonly takeExitNotice: (id: number) => ExitNotice | undefined
  readonly subscribe: (listener: (event: TerminalEvent) => void) => () => void
  readonly dispose: () => void
}

export const makeTerminalStore = (): TerminalStore => {
  const entries = new Map<number, Entry>()
  const listeners = new Set<(event: TerminalEvent) => void>()
  let nextId = 1

  const emit = (event: TerminalEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  const update = (entry: Entry, patch: Partial<TerminalInfo>): void => {
    entry.info = { ...entry.info, ...patch }
    emit({ type: "state", terminal: entry.info })
  }
  const drop = (entry: Entry): void => {
    if (!entries.delete(entry.info.id)) return
    entry.detach()
    emit({ type: "removed", terminal: entry.info })
  }
  const prune = (): void => {
    const detached = [...entries.values()].filter((entry) => entry.info.phase === "detached")
    if (detached.length <= MAX_DETACHED) return
    const oldest = [
      ...detached.filter((entry) => entry.info.exit !== undefined),
      ...detached.filter((entry) => entry.info.exit === undefined)
    ].slice(0, detached.length - MAX_DETACHED)
    for (const entry of oldest) {
      entry.process.kill()
      drop(entry)
    }
  }

  return {
    start: (input) => {
      const id = nextId++
      const decoders: Record<OutputStream, StringDecoder> = {
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8")
      }
      const info: TerminalInfo = {
        id,
        sessionId: input.sessionId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        command: input.command,
        cwd: input.cwd,
        access: input.access,
        approvalMode: input.approvalMode,
        pid: input.process.pid,
        input: input.process.input,
        startedAt: currentMillis(),
        phase: "foreground",
        exit: undefined,
        endedAt: undefined
      }
      const stopData = input.process.onData((stream, chunk) => {
        const current = entries.get(id)
        if (current === undefined) return
        const data = decoders[stream].write(chunk)
        if (data.length === 0) return
        current.cursor += data.length
        current.replay = (current.replay + data).slice(-MAX_REPLAY_CHARS)
        emit({ type: "output", terminal: current.info, data, cursor: current.cursor })
      })
      const stopExit = input.process.onExit((exit) => {
        const current = entries.get(id)
        if (current !== undefined) update(current, { exit, endedAt: currentMillis() })
      })
      const entry: Entry = {
        info,
        process: input.process,
        replay: "",
        cursor: 0,
        readCursor: 0,
        readerCursors: new Map(),
        exitNotice: "pending",
        detach: () => {
          stopData()
          stopExit()
        }
      }
      entries.set(id, entry)
      emit({ type: "state", terminal: info })
      return info
    },
    release: (id) => {
      const entry = entries.get(id)
      if (entry !== undefined) drop(entry)
    },
    detach: (id) => {
      const entry = entries.get(id)
      if (entry === undefined) return undefined
      entry.readCursor = entry.cursor
      update(entry, { phase: "detached" })
      prune()
      return entries.get(id)?.info
    },
    get: (id) => entries.get(id)?.info,
    all: () => [...entries.values()].map((entry) => entry.info),
    list: (sessionId) =>
      [...entries.values()]
        .filter((entry) => entry.info.sessionId === sessionId)
        .map((entry) => entry.info),
    replay: (id) => {
      const entry = entries.get(id)
      return entry === undefined ? undefined : { output: entry.replay, cursor: entry.cursor }
    },
    read: (id, readerId) => {
      const entry = entries.get(id)
      if (entry === undefined) return undefined
      const available = entry.cursor - entry.replay.length
      const previous =
        readerId === undefined ? entry.readCursor : (entry.readerCursors.get(readerId) ?? available)
      const from = Math.max(previous, available)
      const unread = entry.replay.slice(from - available)
      const dropped = from - previous
      if (readerId === undefined) {
        entry.readCursor = entry.cursor
        if (entry.info.exit !== undefined) entry.exitNotice = "done"
      } else {
        entry.readerCursors.delete(readerId)
        entry.readerCursors.set(readerId, entry.cursor)
        if (entry.readerCursors.size > 16) {
          const oldest = entry.readerCursors.keys().next().value
          if (oldest !== undefined) entry.readerCursors.delete(oldest)
        }
      }
      if (unread.length <= MAX_READ_CHARS)
        return { output: unread, omitted: dropped, exit: entry.info.exit }
      const half = MAX_READ_CHARS / 2
      return {
        output: `${unread.slice(0, half)}\n[... ${unread.length - MAX_READ_CHARS} characters omitted ...]\n${unread.slice(-half)}`,
        omitted: dropped,
        exit: entry.info.exit
      }
    },
    wait: (id, { ms, signal }) =>
      new Promise((resolve) => {
        const entry = entries.get(id)
        if (entry === undefined || entry.info.exit !== undefined || signal.aborted) {
          resolve()
          return
        }
        const done = (): void => {
          clearTimeout(timer)
          stopExit()
          signal.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        const stopExit = entry.process.onExit(() => queueMicrotask(done))
        signal.addEventListener("abort", done, { once: true })
      }),
    write: (id, chars) => {
      const entry = entries.get(id)
      if (entry === undefined || entry.info.exit !== undefined) return "exited"
      if (chars === "\u0003") {
        entry.process.interrupt()
        return "sent"
      }
      if (entry.process.input === "closed") return "stdin_closed"
      return entry.process.write(chars) ? "sent" : "exited"
    },
    kill: (id, options) => {
      const entry = entries.get(id)
      if (entry === undefined) return
      if (options?.notify === false) entry.exitNotice = "done"
      entry.process.kill()
    },
    stopRuns: (runIds) => {
      const stopped = new Set(runIds)
      for (const entry of entries.values()) {
        if (!stopped.has(entry.info.runId) || entry.info.exit !== undefined) continue
        entry.exitNotice = "done"
        entry.process.kill()
      }
    },
    peekExitNotice: (id) => unreadExit(entries.get(id)),
    takeExitNotice: (id) => {
      const entry = entries.get(id)
      const notice = unreadExit(entry)
      if (entry === undefined || notice === undefined) return undefined
      entry.exitNotice = "done"
      entry.readCursor = entry.cursor
      return notice
    },
    remove: (id) => {
      const entry = entries.get(id)
      if (entry === undefined) return
      entry.process.kill()
      drop(entry)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      for (const entry of [...entries.values()]) {
        entry.process.kill()
        drop(entry)
      }
      listeners.clear()
    }
  }
}

const unreadExit = (entry: Entry | undefined): ExitNotice | undefined => {
  if (
    entry === undefined ||
    entry.info.phase !== "detached" ||
    entry.info.exit === undefined ||
    entry.exitNotice === "done"
  )
    return undefined
  const available = entry.cursor - entry.replay.length
  const unread = entry.replay.slice(Math.max(entry.readCursor, available) - available)
  return { terminal: entry.info, tail: unread.slice(-NOTICE_TAIL_CHARS) }
}
