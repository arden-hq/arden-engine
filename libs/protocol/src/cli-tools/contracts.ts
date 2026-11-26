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

export const CLI_TOOL_VERSION = { reported: "reported", unreported: "unreported" } as const

export type CliToolVersion =
  | { readonly kind: "reported"; readonly text: string }
  | { readonly kind: "unreported" }

export type CliToolLogin =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "none" }

export interface CliTool extends JsonRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly command: string
  readonly path: string
  readonly version: CliToolVersion
  readonly sign_in: CliToolSignIn
  readonly login: CliToolLogin
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
