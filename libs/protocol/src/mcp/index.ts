import {
  decoderFor,
  makeEncoder,
  projectedDecoderFor,
  runBoundary,
  strict
} from "../common/boundary.js"
import type {
  GitHubConnectRequest,
  McpPresetId,
  McpServerInput,
  McpServerUpdate
} from "./contracts.js"
import {
  McpOAuthStartResponseSchema,
  McpOfferDeclineReceiptSchema,
  McpOfferListSchema,
  encodeMcpOfferDeclineRequestEffect,
  toMcpOAuthStart,
  McpPresetInstallResponseSchema,
  mapPresetInstall,
  McpPresetListResponseSchema,
  toMcpPresetList,
  McpRemoveReceiptSchema,
  McpServerSchema,
  mapServer,
  McpServerListResponseSchema,
  toMcpServerList,
  encodeMcpCreateServerRequestEffect,
  encodeMcpPresetPathEffect,
  encodeMcpServerPathEffect,
  encodeMcpSetEnabledRequestEffect,
  encodeMcpUpdateServerRequestEffect,
  encodeGitHubConnectRequestEffect,
  encodeGitHubReadOnlyRequestEffect,
  GitHubConnectionStateSchema,
  toGitHubConnectionState
} from "./schema.js"

export * from "./contracts.js"
export * from "./status.js"

export const mcpOAuthClientReferences = {
  github: {
    clientIdReference: "mcp.github.client-id",
    clientSecretReference: "mcp.github.client-secret"
  },
  slack: {
    clientIdReference: "mcp.slack.client-id",
    clientSecretReference: "mcp.slack.client-secret"
  }
} as const
export const mcpOAuthRedirectUri = "http://127.0.0.1:19876/mcp/oauth/callback"

export const mcpDecoders = {
  presets: projectedDecoderFor(
    McpPresetListResponseSchema,
    toMcpPresetList,
    "Invalid MCP preset catalog",
    strict
  ),
  installed: projectedDecoderFor(
    McpPresetInstallResponseSchema,
    mapPresetInstall,
    "Invalid MCP preset installation",
    strict
  ),
  list: projectedDecoderFor(
    McpServerListResponseSchema,
    toMcpServerList,
    "Invalid MCP server list",
    strict
  ),
  server: projectedDecoderFor(McpServerSchema, mapServer, "Invalid MCP server", strict),
  oauth: projectedDecoderFor(
    McpOAuthStartResponseSchema,
    toMcpOAuthStart,
    "Invalid MCP OAuth response",
    strict
  ),
  removed: decoderFor(McpRemoveReceiptSchema, "Invalid MCP removal response", strict),
  offers: decoderFor(McpOfferListSchema, "Invalid MCP offer list", strict),
  offerDeclined: decoderFor(McpOfferDeclineReceiptSchema, "Invalid MCP offer response", strict),
  github: projectedDecoderFor(
    GitHubConnectionStateSchema,
    toGitHubConnectionState,
    "Invalid GitHub connection state",
    strict
  )
} as const

export const mcpRequests = {
  create: makeEncoder<McpServerInput>(
    encodeMcpCreateServerRequestEffect,
    "Invalid MCP server request"
  ),
  update: makeEncoder<McpServerUpdate>(
    encodeMcpUpdateServerRequestEffect,
    "Invalid MCP server update"
  ),
  setEnabled: (enabled: boolean): string =>
    runBoundary(
      encodeMcpSetEnabledRequestEffect({ enabled }),
      "Invalid MCP enabled request",
      "encode"
    ),
  declineOffer: (sessionId: string, toolCallId: string): string =>
    runBoundary(
      encodeMcpOfferDeclineRequestEffect({ session_id: sessionId, tool_call_id: toolCallId }),
      "Invalid MCP offer request",
      "encode"
    ),
  githubConnect: makeEncoder<GitHubConnectRequest>(
    encodeGitHubConnectRequestEffect,
    "Invalid GitHub connect request"
  ),
  githubReadOnly: (readOnly: boolean): string =>
    runBoundary(
      encodeGitHubReadOnlyRequestEffect({ read_only: readOnly }),
      "Invalid GitHub read-only request",
      "encode"
    )
} as const

const serverPath = (name: string) =>
  runBoundary(encodeMcpServerPathEffect(name), "Invalid MCP server route", "encode")

const presetPath = (presetId: McpPresetId) =>
  runBoundary(encodeMcpPresetPathEffect(presetId), "Invalid MCP preset route", "encode")

export const mcpRoutes = {
  collection: "/mcp/servers",
  presets: "/mcp/presets",
  declineOffer: "/mcp/offers/decline",
  offers: (sessionId: string): string => `/mcp/offers/${encodeURIComponent(sessionId)}`,
  installPreset: (presetId: McpPresetId): string => `${presetPath(presetId)}/install`,
  server: serverPath,
  enabled: (name: string): string => `${serverPath(name)}/enabled`,
  reconnect: (name: string): string => `${serverPath(name)}/reconnect`,
  oauth: (name: string): string => `${serverPath(name)}/oauth`,
  github: "/mcp/github",
  githubConnect: "/mcp/github/connect",
  githubReadOnly: "/mcp/github/read-only"
} as const
