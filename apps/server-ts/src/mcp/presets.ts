import { McpPresetIdSchema } from "@arden-hq/protocol/effect/mcp"
import { mcpOAuthClientReferences } from "@arden-hq/protocol/mcp"
import type { McpPreset, McpPresetId } from "@arden-hq/protocol/mcp"
import type { ToolDefaultApproval } from "@arden-hq/protocol/tools"

interface McpOAuthMetadata {
  readonly credentialKey: string
  readonly clientType: "confidential" | "dynamic"
  readonly scopes: ReadonlyArray<string>
}

export interface McpStaticOAuthMetadata extends McpOAuthMetadata {
  readonly clientType: "confidential"
  readonly expectedIssuer: string
  readonly clientIdReference: string
  readonly clientSecretReference: string
}

type McpPresetOAuthMetadata =
  | (McpStaticOAuthMetadata & { readonly type: "oauth" })
  | (McpOAuthMetadata & { readonly type: "oauth"; readonly clientType: "dynamic" })

interface McpPresetTokenAuth {
  readonly type: "token"
}

export interface McpPresetServerDefinition {
  readonly name: string
  readonly title: string
  readonly url: string
  readonly toolApprovals: Readonly<Record<string, ToolDefaultApproval>>
}

export interface McpPresetDefinition {
  readonly title: string
  readonly description: string
  readonly setupUrl: string
  readonly servers: ReadonlyArray<McpPresetServerDefinition>
  readonly auth: McpPresetOAuthMetadata | McpPresetTokenAuth
}

interface PresetCandidate {
  readonly name: string
  readonly presetId: McpPresetId | null
  readonly transport:
    | { readonly type: "stdio" }
    | {
        readonly type: "http"
        readonly url: string
        readonly auth: "none" | "oauth" | "headers"
        readonly headerKeys: ReadonlyArray<string>
      }
}

const SLACK_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "emoji:read",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "search:read.files",
  "search:read.im",
  "search:read.mpim",
  "search:read.private",
  "search:read.public",
  "search:read.users",
  "users:read",
  "users:read.email"
] as const

export const MCP_PRESETS = {
  github: {
    title: "GitHub",
    description: "Repositories, issues, and pull requests.",
    setupUrl: "https://github.com/settings/apps",
    servers: [
      {
        name: "github",
        title: "GitHub",
        url: "https://api.githubcopilot.com/mcp",
        toolApprovals: {}
      }
    ],
    auth: { type: "token" }
  },
  linear: {
    title: "Linear",
    description: "Issues, projects, and cycles.",
    setupUrl: "https://linear.app/docs/mcp",
    servers: [
      {
        name: "linear",
        title: "Linear",
        url: "https://mcp.linear.app/mcp",
        toolApprovals: {}
      }
    ],
    auth: {
      type: "oauth",
      credentialKey: "preset:linear",
      clientType: "dynamic",
      scopes: []
    }
  },
  notion: {
    title: "Notion",
    description: "Pages, databases, and comments.",
    setupUrl: "https://developers.notion.com/guides/mcp/build-mcp-client",
    servers: [
      {
        name: "notion",
        title: "Notion",
        url: "https://mcp.notion.com/mcp",
        toolApprovals: {}
      }
    ],
    auth: {
      type: "oauth",
      credentialKey: "preset:notion",
      clientType: "dynamic",
      scopes: []
    }
  },
  slack: {
    title: "Slack",
    description: "Search, read, and send Slack messages and files.",
    setupUrl: "https://docs.slack.dev/authentication/installing-with-oauth",
    servers: [
      {
        name: "slack",
        title: "Slack",
        url: "https://mcp.slack.com/mcp",
        toolApprovals: {}
      }
    ],
    auth: {
      type: "oauth",
      credentialKey: "preset:slack",
      clientType: "confidential",
      expectedIssuer: "https://mcp.slack.com",
      ...mcpOAuthClientReferences.slack,
      scopes: SLACK_SCOPES
    }
  },
  vercel: {
    title: "Vercel",
    description: "Projects, deployments, and platform docs.",
    setupUrl: "https://vercel.com/docs/mcp/vercel-mcp",
    servers: [
      {
        name: "vercel",
        title: "Vercel",
        url: "https://mcp.vercel.com",
        toolApprovals: {}
      }
    ],
    auth: {
      type: "oauth",
      credentialKey: "preset:vercel",
      clientType: "dynamic",
      scopes: []
    }
  }
} as const satisfies Record<McpPresetId, McpPresetDefinition>

export const mcpPresetCatalog = (): ReadonlyArray<McpPreset> =>
  McpPresetIdSchema.literals.map((id) => {
    const preset: McpPresetDefinition = MCP_PRESETS[id]
    return {
      id,
      title: preset.title,
      description: preset.description,
      setupUrl: preset.setupUrl,
      servers: preset.servers.map((server) => ({
        name: server.name,
        title: server.title,
        url: server.url
      })),
      auth:
        preset.auth.type === "token"
          ? { type: "token" }
          : { type: "oauth", clientType: preset.auth.clientType, scopes: preset.auth.scopes }
    }
  })

export const mcpPresetTransportAuth = (presetId: McpPresetId): "oauth" | "none" =>
  MCP_PRESETS[presetId].auth.type === "token" ? "none" : "oauth"

export const usesPresetToken = (candidate: PresetCandidate): boolean =>
  candidate.presetId !== null &&
  MCP_PRESETS[candidate.presetId].auth.type === "token" &&
  resolveMcpPresetServer(candidate) !== undefined

export const resolveMcpPresetServer = (
  candidate: PresetCandidate
): McpPresetServerDefinition | undefined => {
  if (candidate.presetId === null || candidate.transport.type !== "http") return undefined
  if (
    candidate.transport.auth !== mcpPresetTransportAuth(candidate.presetId) ||
    candidate.transport.headerKeys.length > 0
  ) {
    return undefined
  }
  const url = candidate.transport.url
  return MCP_PRESETS[candidate.presetId].servers.find(
    (server) => server.name === candidate.name && server.url === url
  )
}

export const mcpToolApproval = (
  candidate: PresetCandidate,
  remoteName: string
): ToolDefaultApproval => resolveMcpPresetServer(candidate)?.toolApprovals[remoteName] ?? "ask"
