import type { ModelEndpointKind } from "@arden-hq/protocol/model-endpoints"
import { Effect, Schema } from "effect"

import {
  type CredentialVault,
  decodeVaultValue,
  readSecureDocument,
  requireVault,
  type SecureDocumentTarget,
  vaultOperation,
  writeSecureDocument
} from "../../credentials/vault.js"

type SecretOwner = ModelEndpointKind | { readonly chat: string }

const secretTarget = (owner: SecretOwner): SecureDocumentTarget => {
  const name = typeof owner === "string" ? owner : `chat:${owner.chat}`
  return { documentKey: `model-endpoint:${name}`, binding: `model-endpoint:${name}:v1` }
}

const SecretDocumentSchema = Schema.Struct({ secret: Schema.NonEmptyString })

export interface EndpointSecrets<E> {
  readonly read: (owner: SecretOwner) => Effect.Effect<string | undefined, E>
  readonly write: (owner: SecretOwner, secret: string) => Effect.Effect<void, E>
  readonly clear: (owner: SecretOwner) => Effect.Effect<void, E>
  readonly readDocument: (owner: SecretOwner) => Effect.Effect<unknown | null, E>
  readonly restore: (owner: SecretOwner, value: unknown | null) => Effect.Effect<void, E>
}

export const endpointSecrets = <E>(
  vault: CredentialVault | undefined,
  storage: (message: string) => (cause: unknown) => E
): EndpointSecrets<E> => {
  const read = (owner: SecretOwner) =>
    Effect.tryPromise({
      try: async () => {
        const value = await readSecureDocument(vault, secretTarget(owner))
        if (value === null) return undefined
        const decoded = await decodeVaultValue(
          SecretDocumentSchema,
          value,
          "The saved endpoint key is unreadable"
        )
        return decoded.secret
      },
      catch: storage("Could not read the endpoint key")
    })
  const write = (owner: SecretOwner, secret: string) =>
    Effect.tryPromise({
      try: () => writeSecureDocument(vault, secretTarget(owner), { secret }),
      catch: storage("Could not save the endpoint key")
    })
  const clear = (owner: SecretOwner) =>
    Effect.tryPromise({
      try: () =>
        vaultOperation("Could not delete the endpoint key", () =>
          requireVault(vault).clearDocument(secretTarget(owner))
        ),
      catch: storage("Could not delete the endpoint key")
    })
  const readDocument = (owner: SecretOwner) =>
    Effect.tryPromise({
      try: () => readSecureDocument(vault, secretTarget(owner)),
      catch: storage("Could not read the endpoint key")
    })
  const restore = (owner: SecretOwner, value: unknown | null) =>
    value === null
      ? clear(owner)
      : Effect.tryPromise({
          try: () => writeSecureDocument(vault, secretTarget(owner), value),
          catch: storage("Could not restore the endpoint key")
        })
  return { read, write, clear, readDocument, restore }
}
