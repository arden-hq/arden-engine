import { basename } from "node:path"
import type { MonitoredProcess, ProcessOwner } from "@arden-hq/protocol/processes"
import type { TerminalInfo } from "../terminals/store.js"

export interface ProcessCounter {
  readonly pid: number
  readonly parentPid: number
  readonly started: string
  readonly cpuMillis: number
  readonly memoryBytes: number
  readonly name: string
}

function parseCpuTime(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value)
  if (match === null) return undefined
  return (
    (Number(match[1] ?? 0) * 86400 +
      Number(match[2] ?? 0) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4])) *
    1000
  )
}

export function parseProcessTable(text: string): ProcessCounter[] {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line)
    if (match === null) return []
    const cpuMillis = parseCpuTime(match[4] ?? "")
    if (cpuMillis === undefined) return []
    return [
      {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        started: match[3] ?? "",
        cpuMillis,
        memoryBytes: Number(match[5]) * 1024,
        name: basename(match[6] ?? "")
      }
    ]
  })
}

const keyOf = (counter: ProcessCounter): string => `${counter.pid}:${counter.started}`

export interface ServiceProcess {
  readonly pid: number
  readonly name: string
  readonly group: string
  readonly childName?: string
}

export class ProcessSampler {
  private previous:
    | { readonly at: number; readonly counters: ReadonlyMap<string, ProcessCounter> }
    | undefined
  private owners = new Map<string, ProcessOwner>()
  private roots = new Map<number, string>()

  sample({
    counters,
    terminals,
    rootPid,
    at,
    cpuCount,
    services = []
  }: {
    readonly counters: readonly ProcessCounter[]
    readonly terminals: readonly TerminalInfo[]
    readonly rootPid: number
    readonly at: number
    readonly cpuCount: number
    readonly services?: readonly ServiceProcess[]
  }): MonitoredProcess[] {
    const byPid = new Map(counters.map((counter) => [counter.pid, counter]))
    const active = new Map(
      terminals
        .filter((terminal) => terminal.exit === undefined && terminal.pid !== undefined)
        .map((terminal) => [terminal.pid, terminal])
    )
    const root = byPid.get(rootPid)
    const nextOwners = new Map<string, ProcessOwner>()
    const rootOwner = (counter: ProcessCounter): ProcessOwner | undefined => {
      const seen = new Set<number>()
      let ancestor: ProcessCounter | undefined = counter
      let remembered: ProcessOwner | undefined
      let shared: ProcessOwner | undefined
      while (ancestor !== undefined && !seen.has(ancestor.pid)) {
        seen.add(ancestor.pid)
        const terminal = active.get(ancestor.pid)
        if (terminal !== undefined) {
          const identity = keyOf(ancestor)
          const recorded = this.roots.get(terminal.id)
          const born = Date.parse(ancestor.started)
          if (recorded !== undefined && recorded !== identity) return undefined
          if (
            recorded === undefined &&
            (!Number.isFinite(born) || Math.abs(born - terminal.startedAt) > 5000)
          )
            return undefined
          this.roots.set(terminal.id, identity)
          return {
            kind: "command",
            terminal_id: terminal.id,
            session_id: terminal.sessionId,
            run_id: terminal.runId,
            name: terminal.sessionId,
            command: terminal.command,
            cwd: terminal.cwd,
            root_key: keyOf(ancestor)
          }
        }
        remembered ??= this.owners.get(keyOf(ancestor))
        const service = services.find((service) => service.pid === ancestor?.pid)
        if (service !== undefined) shared ??= { kind: "shared", name: service.group }
        if (root !== undefined && ancestor.pid === root.pid) {
          shared ??= { kind: "shared", name: "Arden" }
          break
        }
        ancestor = byPid.get(ancestor.parentPid)
      }
      return remembered?.kind === "command" ? remembered : (shared ?? remembered)
    }
    const processes = counters.flatMap((counter) => {
      const key = keyOf(counter)
      const owner = rootOwner(counter)
      if (owner === undefined) return []
      nextOwners.set(key, owner)
      const previous = this.previous?.counters.get(key)
      const elapsed = this.previous === undefined ? 0 : at - this.previous.at
      const delta = previous === undefined ? undefined : counter.cpuMillis - previous.cpuMillis
      const cpu =
        delta === undefined || delta < 0 || elapsed <= 0 || elapsed > 10000
          ? null
          : Math.min(100, (delta / elapsed / Math.max(1, cpuCount)) * 100)
      const terminal =
        owner.kind === "command"
          ? terminals.find((terminal) => terminal.id === owner.terminal_id)
          : undefined
      const ownerRoot = terminal?.pid === undefined ? undefined : byPid.get(terminal.pid)
      const service = serviceFor(counter, byPid, services)
      const serviceName = service?.pid === counter.pid ? service.name : service?.childName
      return [
        {
          key,
          pid: counter.pid,
          parent_pid: counter.parentPid,
          name: owner.kind === "shared" ? (serviceName ?? counter.name) : counter.name,
          owner,
          cpu_percent: cpu,
          memory_bytes: counter.memoryBytes,
          can_stop:
            owner.kind === "command" &&
            terminal?.exit === undefined &&
            ownerRoot !== undefined &&
            keyOf(ownerRoot) === owner.root_key
        }
      ]
    })
    for (const id of this.roots.keys())
      if (!terminals.some((terminal) => terminal.id === id)) this.roots.delete(id)
    this.owners = nextOwners
    this.previous = {
      at,
      counters: new Map(
        counters
          .filter((counter) => nextOwners.has(keyOf(counter)))
          .map((counter) => [keyOf(counter), counter])
      )
    }
    return processes
  }
}

function serviceFor(
  counter: ProcessCounter,
  counters: ReadonlyMap<number, ProcessCounter>,
  services: readonly ServiceProcess[]
): ServiceProcess | undefined {
  const seen = new Set<number>()
  let current: ProcessCounter | undefined = counter
  while (current !== undefined && !seen.has(current.pid)) {
    seen.add(current.pid)
    const service = services.find((service) => service.pid === current?.pid)
    if (service !== undefined) return service
    current = counters.get(current.parentPid)
  }
  return undefined
}
