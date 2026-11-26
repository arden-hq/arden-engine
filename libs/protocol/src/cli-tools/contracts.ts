import type { JsonRecord } from "../common/json.js"

export const CLI_TOOL_SIGN_IN = {
  signedIn: "signed_in",
  signedOut: "signed_out",
  unknown: "unknown"
} as const

export type CliToolSignIn = (typeof CLI_TOOL_SIGN_IN)[keyof typeof CLI_TOOL_SIGN_IN]

export const CLI_TOOL_SKILL = { builtIn: "built_in", installed: "installed", none: "none" } as const

export type CliToolSkill =
  | { readonly kind: typeof CLI_TOOL_SKILL.builtIn; readonly name: string }
  | {
      readonly kind: typeof CLI_TOOL_SKILL.installed
      readonly name: string
      readonly enabled: boolean
    }
  | { readonly kind: typeof CLI_TOOL_SKILL.none }

export const CLI_TOOL_VERSION = { reported: "reported", unreported: "unreported" } as const

export type CliToolVersion =
  | { readonly kind: typeof CLI_TOOL_VERSION.reported; readonly text: string }
  | { readonly kind: typeof CLI_TOOL_VERSION.unreported }

export const CLI_TOOL_LOGIN = { command: "command", none: "none" } as const

export type CliToolLogin =
  | { readonly kind: typeof CLI_TOOL_LOGIN.command; readonly command: string }
  | { readonly kind: typeof CLI_TOOL_LOGIN.none }

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

export const CLI_TOOLS_PATH_SOURCE = { loginShell: "login_shell", process: "process" } as const

export type CliToolsPathSource = (typeof CLI_TOOLS_PATH_SOURCE)[keyof typeof CLI_TOOLS_PATH_SOURCE]

export interface CliToolsReport extends JsonRecord {
  readonly tools: ReadonlyArray<CliTool>
  readonly path_source: CliToolsPathSource
  readonly checked_at: string
}
