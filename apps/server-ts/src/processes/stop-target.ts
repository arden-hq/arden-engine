import type { MonitoredProcess } from "@arden-hq/protocol/processes"
import type { TerminalInfo } from "../terminals/store.js"
import type { ProcessCounter } from "./sampling.js"

export function processStopTarget({
  row,
  terminals,
  counters
}: {
  readonly row: MonitoredProcess | undefined
  readonly terminals: readonly TerminalInfo[]
  readonly counters: readonly ProcessCounter[]
}): TerminalInfo | undefined {
  if (row === undefined || row.owner.kind !== "command" || !row.can_stop) return undefined
  const owner = row.owner
  const terminal = terminals.find((item) => item.id === owner.terminal_id)
  if (
    terminal === undefined ||
    terminal.exit !== undefined ||
    terminal.sessionId !== owner.session_id ||
    terminal.runId !== owner.run_id
  )
    return undefined
  const selected = counters.find((counter) => `${counter.pid}:${counter.started}` === row.key)
  const root = counters.find((counter) => counter.pid === terminal.pid)
  if (
    selected === undefined ||
    root === undefined ||
    `${root.pid}:${root.started}` !== owner.root_key
  )
    return undefined
  return terminal
}
