import type { JsonRecord } from "../../common/json.js"

/** A command Arden left running in a Chat, or one that has since ended. */
export interface SessionTerminal extends JsonRecord {
  readonly id: number
  /** The exec_command call that started it. */
  readonly tool_call_id: string
  readonly command: string
  readonly cwd: string
  readonly access: "sandbox" | "network" | "host"
  /** Started with its input open, so typing reaches it. */
  readonly tty: boolean
  readonly state: "running" | "exited"
  readonly exit_code: number | null
  readonly signal: string | null
  readonly started_at: string
  readonly ended_at: string | null
  /** Characters of output so far; grows while it runs. */
  readonly cursor: number
}

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
