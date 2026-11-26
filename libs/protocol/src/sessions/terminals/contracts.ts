import type { JsonRecord } from "../../common/json.js"

export const TERMINAL_STATE = { running: "running", exited: "exited" } as const

export type TerminalExit =
  | { readonly kind: "code"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: string }

interface SessionTerminalFields extends JsonRecord {
  readonly id: number
  readonly tool_call_id: string
  readonly command: string
  readonly cwd: string
  readonly access: "sandbox" | "network" | "host"
  readonly tty: boolean
  readonly started_at: string
  readonly cursor: number
}

export interface RunningSessionTerminal extends SessionTerminalFields {
  readonly state: typeof TERMINAL_STATE.running
}

export interface ExitedSessionTerminal extends SessionTerminalFields {
  readonly state: typeof TERMINAL_STATE.exited
  readonly exit: TerminalExit
  readonly ended_at: string
}

export type SessionTerminal = RunningSessionTerminal | ExitedSessionTerminal

export interface SessionTerminalsResponse extends JsonRecord {
  readonly terminals: ReadonlyArray<SessionTerminal>
}

/** Output after a cursor; `start` passes `after` when older output was dropped. */
export interface TerminalOutputResponse extends JsonRecord {
  readonly output: string
  readonly start: number
  readonly cursor: number
}

/** Stop and close answer with this once the command is handled. */
export interface TerminalActionResponse extends JsonRecord {
  readonly ok: true
}

export interface TerminalInputRequest {
  readonly chars: string
}

/** "sent" — delivered; "stdin_closed" — started without tty; "exited" — nothing is running. */
export interface TerminalInputResponse extends JsonRecord {
  readonly status: "sent" | "stdin_closed" | "exited"
}
