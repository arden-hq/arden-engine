import {
  MCP_ACCOUNT,
  MCP_DIAGNOSTICS,
  MCP_FOLDER,
  MCP_SERVER_DETAIL,
  MCP_SERVER_PRESET,
  MCP_TOOL_TITLE,
  MCP_TRANSPORT,
  type McpFolder,
  type McpServer
} from "@arden-hq/protocol/mcp"
import type { ConnectedServer } from "../persistence/capability-offers/match.js"
import type { RuntimeEntry } from "./runtime.js"

const publicFolder = (cwd: string | null): McpFolder =>
  cwd === null ? { kind: MCP_FOLDER.home } : { kind: MCP_FOLDER.folder, path: cwd }

export const publicServer = (entry: RuntimeEntry, identity: string | null): McpServer => {
  const { config } = entry
  const transport = config.transport
  return {
    name: config.name,
    preset:
      config.presetId === null
        ? { kind: MCP_SERVER_PRESET.custom }
        : { kind: MCP_SERVER_PRESET.preset, id: config.presetId },
    enabled: config.enabled,
    status: entry.status,
    detail:
      entry.detail === null
        ? { kind: MCP_SERVER_DETAIL.quiet }
        : { kind: MCP_SERVER_DETAIL.shown, text: entry.detail },
    diagnostics:
      entry.diagnostics === undefined
        ? { kind: MCP_DIAGNOSTICS.clean }
        : { kind: MCP_DIAGNOSTICS.captured, text: entry.diagnostics },
    account:
      identity === null
        ? { kind: MCP_ACCOUNT.unknown }
        : { kind: MCP_ACCOUNT.identified, identity },
    transport:
      transport.type === MCP_TRANSPORT.stdio
        ? {
            type: "stdio",
            command: transport.command,
            args: transport.args,
            environmentKeys: transport.environmentKeys,
            cwd: publicFolder(transport.cwd)
          }
        : {
            type: "http",
            url: transport.url,
            auth: transport.auth,
            headerKeys: transport.headerKeys
          },
    tools: entry.tools.map((tool) => ({
      name: tool.remoteName,
      fullName: tool.fullName,
      title:
        tool.title === null
          ? { kind: MCP_TOOL_TITLE.untitled }
          : { kind: MCP_TOOL_TITLE.titled, text: tool.title },
      description: tool.description
    })),
    events: entry.events
  }
}

export const connectedServer = (server: McpServer): ConnectedServer => ({
  presetId: server.preset.kind === MCP_SERVER_PRESET.preset ? server.preset.id : undefined,
  url: server.transport.type === MCP_TRANSPORT.http ? server.transport.url : undefined
})
