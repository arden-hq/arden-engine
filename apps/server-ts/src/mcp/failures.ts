import { VAULT_ERROR_REASON, VaultError } from "../credentials/vault.js"
import { type McpStoredServer } from "../persistence/mcp/store.js"
import { McpConnectionError, mcpError } from "./errors.js"
import { GitHubTokenRejected } from "./github-connection.js"
import { mcpServiceTitle } from "./transport.js"

export const notAnswering = (config: McpStoredServer): string =>
  `${mcpServiceTitle(config)} isn’t answering right now. Try again in a few minutes.`

export const githubFailure = (fallback: string, cause: unknown): McpConnectionError => {
  if (cause instanceof McpConnectionError) return cause
  if (cause instanceof GitHubTokenRejected) {
    return mcpError("github", "rejected", cause.detail, cause)
  }
  if (cause instanceof VaultError) {
    return mcpError(
      "github",
      "unavailable",
      "Arden’s secure storage isn’t available right now. Try again in a moment.",
      cause
    )
  }
  return mcpError("github", "unavailable", `${fallback}. Try again in a moment.`, cause)
}

export const vaultAwareFailure = (
  operation: "create" | "update",
  fallback: string,
  cause: unknown
): McpConnectionError => {
  if (cause instanceof McpConnectionError) return cause
  if (cause instanceof VaultError) {
    return cause.reason === VAULT_ERROR_REASON.invalid
      ? mcpError(operation, "invalid", cause.message, cause)
      : mcpError(
          operation,
          "unavailable",
          "Arden’s secure storage isn’t available right now. Try again in a moment.",
          cause
        )
  }
  return mcpError(operation, "invalid", fallback, cause)
}
