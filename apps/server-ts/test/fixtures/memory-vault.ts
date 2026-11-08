import type { CredentialVault } from "../../src/credentials/vault.js"

export const memoryVault = (): CredentialVault => {
  const documents = new Map<string, unknown>()
  return {
    readDocument: async (target) => documents.get(target.documentKey) ?? null,
    writeDocument: async (target, value) => {
      documents.set(target.documentKey, structuredClone(value))
    },
    clearDocument: async (target) => {
      documents.delete(target.documentKey)
    }
  }
}
