import type { JsonRecord } from "../common/json.js"

import type { McpConnectionStatus } from "./status.js"

export const MCP_PRESET_ID = {
  github: "github",
  linear: "linear",
  notion: "notion",
  slack: "slack",
  vercel: "vercel"
} as const

export type McpPresetId = (typeof MCP_PRESET_ID)[keyof typeof MCP_PRESET_ID]

export interface McpPresetServer extends JsonRecord {
  readonly name: string
  readonly title: string
  readonly url: string
}

export const MCP_PRESET_AUTH = { oauth: "oauth", token: "token" } as const

export const MCP_OAUTH_CLIENT = { confidential: "confidential", dynamic: "dynamic" } as const

export type McpOAuthClient = (typeof MCP_OAUTH_CLIENT)[keyof typeof MCP_OAUTH_CLIENT]

export interface McpPresetOAuth extends JsonRecord {
  readonly type: typeof MCP_PRESET_AUTH.oauth
  readonly clientType: McpOAuthClient
  readonly scopes: ReadonlyArray<string>
}

export interface McpPresetToken extends JsonRecord {
  readonly type: typeof MCP_PRESET_AUTH.token
}

export interface McpPreset extends JsonRecord {
  readonly id: McpPresetId
  readonly title: string
  readonly description: string
  readonly setupUrl: string
  readonly servers: ReadonlyArray<McpPresetServer>
  readonly auth: McpPresetOAuth | McpPresetToken
}

export interface McpPresetListResponse extends JsonRecord {
  readonly presets: ReadonlyArray<McpPreset>
}

export interface McpSecretPatch extends JsonRecord {
  readonly set: Readonly<Record<string, string>>
  readonly retain: ReadonlyArray<string>
}

export const MCP_TRANSPORT = { stdio: "stdio", http: "http" } as const

export type McpTransportKind = (typeof MCP_TRANSPORT)[keyof typeof MCP_TRANSPORT]

export const MCP_AUTH = { none: "none", oauth: "oauth", headers: "headers" } as const

export type McpAuth = (typeof MCP_AUTH)[keyof typeof MCP_AUTH]

export const MCP_FOLDER = { keep: "keep", home: "home", folder: "folder" } as const

export type McpFolder =
  | { readonly kind: typeof MCP_FOLDER.home }
  | { readonly kind: typeof MCP_FOLDER.folder; readonly path: string }

export type McpFolderInput = { readonly kind: typeof MCP_FOLDER.keep } | McpFolder

export interface McpStdioTransport extends JsonRecord {
  readonly type: typeof MCP_TRANSPORT.stdio
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly environmentKeys: ReadonlyArray<string>
  readonly cwd: McpFolder
}

export interface McpHttpTransport extends JsonRecord {
  readonly type: typeof MCP_TRANSPORT.http
  readonly url: string
  readonly auth: McpAuth
  readonly headerKeys: ReadonlyArray<string>
}

export type McpTransport = McpStdioTransport | McpHttpTransport

export const MCP_TOOL_TITLE = { untitled: "untitled", titled: "titled" } as const

export type McpToolTitle =
  | { readonly kind: typeof MCP_TOOL_TITLE.untitled }
  | { readonly kind: typeof MCP_TOOL_TITLE.titled; readonly text: string }

export interface McpTool extends JsonRecord {
  readonly name: string
  readonly fullName: string
  readonly title: McpToolTitle
  readonly description: string
}

export const MCP_EVENT_DELIVERY = { poll: "poll", push: "push", webhook: "webhook" } as const

export type McpEventDelivery = (typeof MCP_EVENT_DELIVERY)[keyof typeof MCP_EVENT_DELIVERY]

export interface McpEvent extends JsonRecord {
  readonly name: string
  readonly description: string
  readonly delivery: ReadonlyArray<McpEventDelivery>
  readonly inputSchema: JsonRecord
}

export const MCP_SERVER_PRESET = { custom: "custom", preset: "preset" } as const

export type McpServerPreset =
  | { readonly kind: typeof MCP_SERVER_PRESET.custom }
  | { readonly kind: typeof MCP_SERVER_PRESET.preset; readonly id: McpPresetId }

export const MCP_SERVER_DETAIL = { quiet: "quiet", shown: "shown" } as const

export type McpServerDetail =
  | { readonly kind: typeof MCP_SERVER_DETAIL.quiet }
  | { readonly kind: typeof MCP_SERVER_DETAIL.shown; readonly text: string }

export const MCP_DIAGNOSTICS = { clean: "clean", captured: "captured" } as const

export type McpDiagnostics =
  | { readonly kind: typeof MCP_DIAGNOSTICS.clean }
  | { readonly kind: typeof MCP_DIAGNOSTICS.captured; readonly text: string }

export const MCP_ACCOUNT = { unknown: "unknown", identified: "identified" } as const

export type McpAccount =
  | { readonly kind: typeof MCP_ACCOUNT.unknown }
  | { readonly kind: typeof MCP_ACCOUNT.identified; readonly identity: string }

export interface McpServer extends JsonRecord {
  readonly name: string
  readonly preset: McpServerPreset
  readonly enabled: boolean
  readonly status: McpConnectionStatus
  readonly detail: McpServerDetail
  readonly diagnostics: McpDiagnostics
  readonly account: McpAccount
  readonly transport: McpTransport
  readonly tools: ReadonlyArray<McpTool>
  readonly events: ReadonlyArray<McpEvent>
}

export interface McpServerListResponse extends JsonRecord {
  readonly servers: ReadonlyArray<McpServer>
}

export interface McpPresetInstallResponse extends JsonRecord {
  readonly presetId: McpPresetId
  readonly servers: ReadonlyArray<McpServer>
}

export interface McpStdioTransportInput extends JsonRecord {
  readonly type: typeof MCP_TRANSPORT.stdio
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly environment: McpSecretPatch
  readonly cwd: McpFolderInput
}

export interface McpHttpTransportInput extends JsonRecord {
  readonly type: typeof MCP_TRANSPORT.http
  readonly url: string
  readonly auth: McpAuth
  readonly headers: McpSecretPatch
}

export type McpTransportInput = McpStdioTransportInput | McpHttpTransportInput

export interface McpServerInput extends JsonRecord {
  readonly name: string
  readonly transport: McpTransportInput
}

export interface McpServerUpdate extends JsonRecord {
  readonly transport: McpTransportInput
}

export const MCP_OAUTH_START = {
  connected: "connected",
  authorized: "authorized",
  pending: "pending"
} as const

export type McpOAuthStartResponse =
  | {
      readonly name: string
      readonly status: typeof MCP_OAUTH_START.connected | typeof MCP_OAUTH_START.authorized
    }
  | {
      readonly name: string
      readonly status: typeof MCP_OAUTH_START.pending
      readonly authorizationUrl: string
    }

export const MCP_OFFER_OUTCOME = {
  open: "open",
  connected: "connected",
  declined: "declined",
  expired: "expired"
} as const

export type McpOfferOutcome = (typeof MCP_OFFER_OUTCOME)[keyof typeof MCP_OFFER_OUTCOME]

export const MCP_OFFER_DECLINE = {
  declined: "declined",
  alreadyAnswered: "already_answered"
} as const

export type McpOfferDecline = (typeof MCP_OFFER_DECLINE)[keyof typeof MCP_OFFER_DECLINE]

export interface McpRemoveReceipt extends JsonRecord {
  readonly status: "removed"
  readonly name: string
}

export const GITHUB_CONNECTION = { disconnected: "disconnected", connected: "connected" } as const

export const GITHUB_CONNECTION_SOURCE = { token: "token", app: "app" } as const

export type GitHubConnectionSource =
  (typeof GITHUB_CONNECTION_SOURCE)[keyof typeof GITHUB_CONNECTION_SOURCE]

export interface GitHubConnectionState {
  readonly connection:
    | { readonly kind: typeof GITHUB_CONNECTION.disconnected }
    | {
        readonly kind: typeof GITHUB_CONNECTION.connected
        readonly readOnly: boolean
        readonly source: GitHubConnectionSource
      }
}

export interface GitHubConnectRequest {
  readonly token: string
}
