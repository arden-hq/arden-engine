import {
  MCP_FOLDER,
  MCP_TRANSPORT,
  type McpFolderInput,
  type McpTransportInput
} from "@arden-hq/protocol/mcp"

import type { McpStoredServer, McpStoredTransport } from "../persistence/mcp/store.js"
import { MCP_OPERATION, mcpError, type McpSaveOperation } from "./errors.js"
import { mcpTransportSecretTarget } from "./transport.js"
import {
  clearMcpTransportSecrets,
  readMcpTransportSecrets,
  writeMcpTransportSecrets,
  type McpOAuthVault
} from "./vault.js"

const secretPatch = (
  input: { readonly set: Readonly<Record<string, string>>; readonly retain: ReadonlyArray<string> },
  existing: Readonly<Record<string, string>> | undefined,
  operation: McpSaveOperation
): Readonly<Record<string, string>> => {
  if (operation === MCP_OPERATION.create && input.retain.length > 0) {
    throw mcpError("create", "invalid", "New MCP servers cannot retain unknown secrets")
  }
  const retained = Object.fromEntries(
    input.retain.map((name) => {
      const value = existing?.[name]
      if (value === undefined)
        throw mcpError("update", "invalid", `MCP secret ${name} does not exist`)
      return [name, value]
    })
  )
  return { ...retained, ...input.set }
}

const storedTransport = (
  input: McpTransportInput,
  secretKeys: ReadonlyArray<string>,
  existing: McpStoredTransport | undefined
): McpStoredTransport =>
  input.type === MCP_TRANSPORT.stdio
    ? {
        type: "stdio",
        command: input.command,
        args: input.args,
        environmentKeys: secretKeys,
        cwd: storedFolder(input.cwd, existing)
      }
    : {
        type: "http",
        url: input.url,
        auth: input.auth,
        headerKeys: secretKeys
      }

const storedFolder = (
  input: McpFolderInput,
  existing: McpStoredTransport | undefined
): string | null => {
  if (input.kind === MCP_FOLDER.folder) return input.path
  if (input.kind === MCP_FOLDER.home) return null
  return existing?.type === MCP_TRANSPORT.stdio ? existing.cwd : null
}

const storedSecretKeys = (transport: McpStoredTransport): ReadonlyArray<string> =>
  transport.type === MCP_TRANSPORT.stdio ? transport.environmentKeys : transport.headerKeys

const inputSecretPatch = (transport: McpTransportInput) =>
  transport.type === MCP_TRANSPORT.stdio ? transport.environment : transport.headers

export interface McpServerSecrets {
  readonly read: (config: McpStoredServer) => Promise<Readonly<Record<string, string>>>
  readonly next: (
    name: string,
    input: McpTransportInput,
    existing: McpStoredServer | undefined,
    operation: McpSaveOperation
  ) => Promise<{
    readonly transport: McpStoredTransport
    readonly secrets: Readonly<Record<string, string>>
    readonly previousSecrets: Readonly<Record<string, string>>
  }>
  readonly save: (
    config: McpStoredServer,
    secrets: Readonly<Record<string, string>>
  ) => Promise<void>
  readonly clear: (config: McpStoredServer) => Promise<void>
}

export const makeMcpServerSecrets = (vault: McpOAuthVault | undefined): McpServerSecrets => {
  const read = (config: McpStoredServer) =>
    readMcpTransportSecrets(
      vault,
      mcpTransportSecretTarget(config),
      storedSecretKeys(config.transport)
    )

  const next = async (
    name: string,
    input: McpTransportInput,
    existing: McpStoredServer | undefined,
    operation: McpSaveOperation
  ): Promise<{
    readonly transport: McpStoredTransport
    readonly secrets: Readonly<Record<string, string>>
    readonly previousSecrets: Readonly<Record<string, string>>
  }> => {
    const previousSecrets = existing === undefined ? {} : await read(existing)
    const retainedSecrets = existing?.transport.type === input.type ? previousSecrets : undefined
    const secrets = secretPatch(inputSecretPatch(input), retainedSecrets, operation)
    const secretKeys = Object.keys(secrets).sort()
    const config = {
      name,
      presetId: existing?.presetId ?? null,
      enabled: existing?.enabled ?? true,
      transport: storedTransport(input, secretKeys, existing?.transport)
    } satisfies McpStoredServer
    return { transport: config.transport, secrets, previousSecrets }
  }

  return {
    read,
    next,
    save: async (
      config: McpStoredServer,
      secrets: Readonly<Record<string, string>>
    ): Promise<void> => writeMcpTransportSecrets(vault, mcpTransportSecretTarget(config), secrets),
    clear: async (config: McpStoredServer): Promise<void> =>
      clearMcpTransportSecrets(vault, mcpTransportSecretTarget(config))
  }
}
