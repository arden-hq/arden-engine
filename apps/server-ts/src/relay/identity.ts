import {
  deviceId,
  fromB64url,
  generateEd25519,
  generateX25519,
  toB64url,
  type Ed25519KeyPair,
  type X25519KeyPair
} from "@arden-hq/relay-protocol"
import { Schema } from "effect"
import {
  decodeVaultValue,
  readSecureDocument,
  writeSecureDocument,
  type CredentialVault
} from "../credentials/vault.js"

export interface MacIdentity {
  readonly macId: string
  readonly ed: Ed25519KeyPair
  readonly x: X25519KeyPair
}

const target = { documentKey: "relay:identity", binding: "relay:identity:v1" } as const

const Key = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))
const DocumentSchema = Schema.Struct({ version: Schema.Literal(1), ed: Key, x: Key })

const identityFromSeeds = (seeds: {
  readonly ed: Uint8Array
  readonly x: Uint8Array
}): MacIdentity => {
  const ed = generateEd25519(seeds.ed)
  return { macId: deviceId(ed.publicKey), ed, x: generateX25519(seeds.x) }
}

export const loadMacIdentity = async (vault: CredentialVault | undefined): Promise<MacIdentity> => {
  const stored = await readSecureDocument(vault, target)
  if (stored !== null) {
    const document = await decodeVaultValue(DocumentSchema, stored, "Relay keys are invalid")
    return identityFromSeeds({ ed: fromB64url(document.ed), x: fromB64url(document.x) })
  }
  const identity = identityFromSeeds({
    ed: generateEd25519().secretKey,
    x: generateX25519().secretKey
  })
  await writeSecureDocument(vault, target, {
    version: 1,
    ed: toB64url(identity.ed.secretKey),
    x: toB64url(identity.x.secretKey)
  })
  return identity
}
