import type { CredentialVault } from "../../src/credentials/vault.js"
import type { McpOAuthVault } from "../../src/mcp/vault.js"

export const memoryVault = (documents = new Map<string, unknown>()): CredentialVault => ({
  readDocument: async (target) => documents.get(target.documentKey) ?? null,
  writeDocument: async (target, value) => {
    documents.set(target.documentKey, structuredClone(value))
  },
  clearDocument: async (target) => {
    documents.delete(target.documentKey)
  }
})

export const memoryServerVault = (documents = new Map<string, unknown>()): McpOAuthVault => {
  const unused = async (): Promise<never> => {
    throw new Error("not used")
  }
  return {
    ...memoryVault(documents),
    read: unused,
    write: unused,
    clear: unused,
    resolveClient: unused,
    readTransportSecrets: unused,
    writeTransportSecrets: unused,
    clearTransportSecrets: unused
  }
}
