import type { McpTransportInput } from "@arden-hq/protocol/mcp"

import type { McpStoredServer, McpStoredTransport } from "../persistence/mcp/store.js"
import { mcpError } from "./errors.js"
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
  operation: "create" | "update"
): Readonly<Record<string, string>> => {
  if (operation === "create" && input.retain.length > 0) {
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
  input.type === "stdio"
    ? {
        type: "stdio",
        command: input.command,
        args: input.args,
        environmentKeys: secretKeys,
        cwd: input.cwd === undefined ? storedCwd(existing) : input.cwd
      }
    : {
        type: "http",
        url: input.url,
        auth: input.auth,
        headerKeys: secretKeys
      }

const storedCwd = (existing: McpStoredTransport | undefined): string | null =>
  existing?.type === "stdio" ? existing.cwd : null

const storedSecretKeys = (transport: McpStoredTransport): ReadonlyArray<string> =>
  transport.type === "stdio" ? transport.environmentKeys : transport.headerKeys

const inputSecretPatch = (transport: McpTransportInput) =>
  transport.type === "stdio" ? transport.environment : transport.headers

export const makeMcpServerSecrets = (vault: McpOAuthVault | undefined) => {
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
    operation: "create" | "update"
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
