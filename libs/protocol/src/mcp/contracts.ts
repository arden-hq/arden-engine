import type { JsonRecord } from "../common/json.js"

import type { McpConnectionStatus } from "./status.js"

export type McpPresetId = "github" | "linear" | "notion" | "slack" | "vercel"

export interface McpPresetServer extends JsonRecord {
  readonly name: string
  readonly title: string
  readonly url: string
}

export interface McpPresetOAuth extends JsonRecord {
  readonly type: "oauth"
  readonly clientType: "confidential" | "dynamic"
  readonly scopes: ReadonlyArray<string>
}

/** A preset that resolves bearer credentials per request. GitHub accepts
 * a personal access token or an OAuth user token. */
export interface McpPresetToken extends JsonRecord {
  readonly type: "token"
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

export const MCP_FOLDER = { keep: "keep", home: "home", folder: "folder" } as const

export type McpFolder =
  | { readonly kind: typeof MCP_FOLDER.home }
  | { readonly kind: typeof MCP_FOLDER.folder; readonly path: string }

export type McpFolderInput = { readonly kind: typeof MCP_FOLDER.keep } | McpFolder

export interface McpStdioTransport extends JsonRecord {
  readonly type: "stdio"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly environmentKeys: ReadonlyArray<string>
  readonly cwd: McpFolder
}

export interface McpHttpTransport extends JsonRecord {
  readonly type: "http"
  readonly url: string
  readonly auth: "none" | "oauth" | "headers"
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

/** How a server can deliver an event; Arden takes `push` over `poll` and never uses `webhook`. */
export type McpEventDelivery = "poll" | "push" | "webhook"

/** One event a server lists (`events/list`): what an `mcp.event` trigger can wait for. */
export interface McpEvent extends JsonRecord {
  readonly name: string
  readonly description: string
  readonly delivery: ReadonlyArray<McpEventDelivery>
  /** JSON Schema of a subscription's arguments. */
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
  /** Empty for a server that lists no events, or none Arden can receive. */
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
  readonly type: "stdio"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly environment: McpSecretPatch
  readonly cwd: McpFolderInput
}

export interface McpHttpTransportInput extends JsonRecord {
  readonly type: "http"
  readonly url: string
  readonly auth: "none" | "oauth" | "headers"
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

export interface McpRemoveReceipt extends JsonRecord {
  readonly status: "removed"
  readonly name: string
}

export const GITHUB_CONNECTION = { disconnected: "disconnected", connected: "connected" } as const

export interface GitHubConnectionState {
  readonly connection:
    | { readonly kind: typeof GITHUB_CONNECTION.disconnected }
    | {
        readonly kind: typeof GITHUB_CONNECTION.connected
        readonly readOnly: boolean
        readonly source: "token" | "app"
      }
}

export interface GitHubConnectRequest {
  readonly token: string
}
