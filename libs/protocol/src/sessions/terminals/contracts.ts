import type { JsonRecord } from "../../common/json.js"

export const TERMINAL_STATE = { running: "running", exited: "exited" } as const

export const TERMINAL_ACCESS = { sandbox: "sandbox", network: "network", host: "host" } as const
export type TerminalAccess = (typeof TERMINAL_ACCESS)[keyof typeof TERMINAL_ACCESS]

export const TERMINAL_INPUT_STATUS = {
  sent: "sent",
  stdin_closed: "stdin_closed",
  exited: "exited"
} as const
export type TerminalInputStatus = (typeof TERMINAL_INPUT_STATUS)[keyof typeof TERMINAL_INPUT_STATUS]

export type TerminalExit =
  | { readonly kind: "code"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: string }

interface SessionTerminalFields extends JsonRecord {
  readonly id: number
  readonly tool_call_id: string
  readonly command: string
  readonly cwd: string
  readonly access: TerminalAccess
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

export interface TerminalOutputResponse extends JsonRecord {
  readonly output: string
  readonly start: number
  readonly cursor: number
}

export interface TerminalActionResponse extends JsonRecord {
  readonly ok: true
}

export interface TerminalInputRequest {
  readonly chars: string
}

export interface TerminalInputResponse extends JsonRecord {
  readonly status: TerminalInputStatus
}
