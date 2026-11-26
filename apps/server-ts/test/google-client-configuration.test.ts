import { expect, it } from "vitest"
import { createGoogleClientConfiguration } from "../src/google/client-configuration.js"
import type { CredentialVault } from "../src/credentials/vault.js"

const vaultHolding = (stored: unknown) => {
  const documents = new Map<string, unknown>([["google:oauth-client", stored]])
  const vault: CredentialVault = {
    readDocument: async (target) => documents.get(target.documentKey) ?? null,
    writeDocument: async (target, value) => {
      documents.set(target.documentKey, value)
    },
    clearDocument: async (target) => {
      documents.delete(target.documentKey)
    }
  }
  return { vault, documents }
}

it("reads a client saved before secrets were tagged, with or without its secret", async () => {
  const confidential = vaultHolding({ version: 1, client: { clientId: "a", clientSecret: "s" } })
  expect(
    await createGoogleClientConfiguration({ vault: confidential.vault, seed: undefined }).read()
  ).toEqual({ clientId: "a", secret: { kind: "confidential", clientSecret: "s" } })
  const open = vaultHolding({ version: 1, client: { clientId: "b" } })
  expect(
    await createGoogleClientConfiguration({ vault: open.vault, seed: undefined }).read()
  ).toEqual({ clientId: "b", secret: { kind: "public" } })
})

it("saves a client in the tagged shape and reads it back", async () => {
  const { vault, documents } = vaultHolding(null)
  const configuration = createGoogleClientConfiguration({ vault, seed: undefined })
  const client = { clientId: "c", secret: { kind: "public" } } as const
  await configuration.write(client)
  expect(documents.get("google:oauth-client")).toEqual({ version: 2, client })
  expect(await configuration.read()).toEqual(client)
})
