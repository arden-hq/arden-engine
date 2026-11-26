import {
  GOOGLE_CLIENT_SECRET,
  sameGoogleClient,
  type GoogleOAuthClient
} from "@arden-hq/protocol/google"
import { GoogleOAuthClientSchema } from "@arden-hq/protocol/effect/google"
import { Schema } from "effect"
import {
  readSecureDocument,
  writeSecureDocument,
  type CredentialVault
} from "../credentials/vault.js"

const target = { documentKey: "google:oauth-client", binding: "google:oauth-client:v1" } as const
const documentSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(2), client: GoogleOAuthClientSchema }),
  Schema.Struct({
    version: Schema.Literal(1),
    client: Schema.Union([
      Schema.Struct({ clientId: Schema.Trimmed, clientSecret: Schema.Trimmed }),
      Schema.Struct({ clientId: Schema.Trimmed })
    ])
  })
])
const decodeDocument = Schema.decodeUnknownSync(documentSchema)
const clientOf = (document: typeof documentSchema.Type): GoogleOAuthClient => {
  if (document.version === 2) return document.client
  const client = document.client
  return {
    clientId: client.clientId,
    secret:
      "clientSecret" in client
        ? { kind: GOOGLE_CLIENT_SECRET.confidential, clientSecret: client.clientSecret }
        : { kind: GOOGLE_CLIENT_SECRET.public }
  }
}

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
        return clientOf(decodeDocument(stored, { onExcessProperty: "error" }))
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
      await writeSecureDocument(vault, target, { version: 2, client: seed })
      const saved = await load()
      if (saved === undefined || !sameGoogleClient(saved, seed)) {
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
      await writeSecureDocument(vault, target, { version: 2, client })
    }
  }
}
