import type { JsonRecord } from "../common/json.js"

/**
 * Whether a detected tool looks signed in, from a harmless local status
 * command. "unknown" — the tool has no such command, or it did not answer.
 */
export type CliToolSignIn = "signed_in" | "signed_out" | "unknown"

/** The Skill that teaches agents a tool, if one is there. */
export type CliToolSkill =
  | { readonly kind: "built_in"; readonly name: string }
  | { readonly kind: "installed"; readonly name: string; readonly enabled: boolean }
  | { readonly kind: "none" }

/** One known command-line tool found on the person's login-shell PATH. */
export interface CliTool extends JsonRecord {
  /** The curated id, e.g. "gh". */
  readonly id: string
  readonly name: string
  readonly description: string
  /** The command as typed, e.g. "gh" or "huggingface-cli". */
  readonly command: string
  readonly path: string
  /** Parsed from its own version command; null when it has none we run or it did not answer. */
  readonly version: string | null
  readonly sign_in: CliToolSignIn
  /** The command that signs it in, as the person types it in a terminal; null
   *  when Arden knows none. */
  readonly login_command: string | null
  readonly skill: CliToolSkill
}

/**
 * Where the PATH came from. "login_shell" — the person's own shell, as their
 * terminal sees it; "process" — Arden's own environment, when the shell did not answer.
 */
export type CliToolsPathSource = "login_shell" | "process"

export interface CliToolsReport extends JsonRecord {
  readonly tools: ReadonlyArray<CliTool>
  readonly path_source: CliToolsPathSource
  readonly checked_at: string
}
