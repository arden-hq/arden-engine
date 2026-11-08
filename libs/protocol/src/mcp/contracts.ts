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

export interface McpStdioTransport extends JsonRecord {
  readonly type: "stdio"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly environmentKeys: ReadonlyArray<string>
  /** The working folder; null is the person's home folder. */
  readonly cwd: string | null
}

export interface McpHttpTransport extends JsonRecord {
  readonly type: "http"
  readonly url: string
  readonly auth: "none" | "oauth" | "headers"
  readonly headerKeys: ReadonlyArray<string>
}

export type McpTransport = McpStdioTransport | McpHttpTransport

export interface McpTool extends JsonRecord {
  readonly name: string
  readonly fullName: string
  readonly title: string | null
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

export interface McpServer extends JsonRecord {
  readonly name: string
  readonly presetId: McpPresetId | null
  readonly enabled: boolean
  readonly status: McpConnectionStatus
  readonly detail: string | null
  /** For a failed local server, the technical detail behind `detail`: the
   *  error and the last lines it wrote to stderr, secrets redacted. */
  readonly diagnostics: string | null
  readonly accountIdentity: string | null
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
  /** Omitted keeps the stored folder; null is the person's home folder. */
  readonly cwd?: string | null
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

export interface McpOAuthStartResponse extends JsonRecord {
  readonly name: string
  readonly authorizationUrl: string | null
  readonly status: "connected" | "pending"
}

export interface McpRemoveReceipt extends JsonRecord {
  readonly status: "removed"
  readonly name: string
}

export interface GitHubConnectionState {
  /** The active credential source and access settings; null when disconnected. */
  readonly connection: { readonly readOnly: boolean; readonly source: "token" | "app" } | null
}

export interface GitHubConnectRequest {
  readonly token: string
}
