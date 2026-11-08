import { sha256Hex } from "@arden-hq/std/hash"

const MAX_TOOL_NAME_LENGTH = 64
const SOURCE_PREFIX = "mcp:"

const toolPrefix = (serverName: string): string => `mcp__${serverName}__`

export const mcpToolName = (serverName: string, remoteName: string): string => {
  const prefix = toolPrefix(serverName)
  if (
    /^[A-Za-z0-9_-]+$/.test(remoteName) &&
    !remoteName.includes("__") &&
    prefix.length + remoteName.length <= MAX_TOOL_NAME_LENGTH
  ) {
    return `${prefix}${remoteName}`
  }
  const safe = remoteName.replace(/[^A-Za-z0-9_-]+/g, "_") || "tool"
  const digest = sha256Hex(remoteName).slice(0, 8)
  const available = Math.max(1, MAX_TOOL_NAME_LENGTH - prefix.length - digest.length - 1)
  return `${prefix}${safe.slice(0, available)}_${digest}`
}

export const mcpSource = (serverName: string): string => `${SOURCE_PREFIX}${serverName}`

export const parseMcpSource = (
  source: string | undefined
): { readonly serverName: string } | undefined => {
  if (source?.startsWith(SOURCE_PREFIX) !== true) return undefined
  const serverName = source.slice(SOURCE_PREFIX.length)
  return serverName.length === 0 ? undefined : { serverName }
}
