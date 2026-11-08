import type { GoogleOAuthClient } from "@arden-hq/protocol/google"
import { GoogleOAuthClientSchema } from "@arden-hq/protocol/effect/google"
import { Schema } from "effect"
import {
  readSecureDocument,
  writeSecureDocument,
  type CredentialVault
} from "../credentials/vault.js"

const target = { documentKey: "google:oauth-client", binding: "google:oauth-client:v1" } as const
const documentSchema = Schema.Struct({
  version: Schema.Literal(1),
  client: GoogleOAuthClientSchema
})
const decodeDocument = Schema.decodeUnknownSync(documentSchema)

export function createGoogleClientConfiguration({
  vault,
  seed
}: {
  readonly vault: CredentialVault | undefined
  readonly seed: GoogleOAuthClient | undefined
}): {
  readonly read: () => Promise<GoogleOAuthClient | undefined>
  readonly write: (client: GoogleOAuthClient) => Promise<void>
} {
  const load = async (): Promise<GoogleOAuthClient | undefined> => {
    const stored = await readSecureDocument(vault, target)
    if (stored !== null) {
      try {
        return decodeDocument(stored, { onExcessProperty: "error" }).client
      } catch {
        throw new Error("Google client storage is invalid")
      }
    }
    return undefined
  }
  let initialization: Promise<void> | undefined
  const initialize = (): Promise<void> =>
    (initialization ??= (async () => {
      if ((await load()) !== undefined || seed === undefined) return
      await writeSecureDocument(vault, target, { version: 1, client: seed })
      const saved = await load()
      if (saved?.clientId !== seed.clientId || saved?.clientSecret !== seed.clientSecret) {
        throw new Error("Google client seed verification failed")
      }
    })().catch((error: unknown) => {
      initialization = undefined
      throw error
    }))
  return {
    read: async () => {
      if (vault === undefined && seed === undefined) return undefined
      await initialize()
      return load()
    },
    write: async (client) => {
      await initialize()
      await writeSecureDocument(vault, target, { version: 1, client })
    }
  }
}
