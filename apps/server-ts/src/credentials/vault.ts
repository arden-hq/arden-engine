import { Effect, Schema } from "effect"

export interface SecureDocumentTarget {
  readonly documentKey: string
  readonly binding: string
}

/**
 * Main-process-owned encrypted storage shared by credential-bearing
 * integrations. A new integration stores its secrets as documents; an
 * integration that needs typed main-process checks extends this interface
 * (`McpOAuthVault`).
 */
export interface CredentialVault {
  readonly readDocument: (target: SecureDocumentTarget) => Promise<unknown | null>
  readonly writeDocument: (target: SecureDocumentTarget, value: unknown) => Promise<void>
  readonly clearDocument: (target: SecureDocumentTarget) => Promise<void>
}

export class VaultError extends Error {
  readonly reason: "unavailable" | "invalid" | "operation"

  constructor(reason: VaultError["reason"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "VaultError"
    this.reason = reason
  }
}

export const requireVault = <V extends CredentialVault>(
  vault: V | undefined,
  storage = "credential"
): V => {
  if (vault === undefined) {
    throw new VaultError("unavailable", `Secure ${storage} storage is unavailable`)
  }
  return vault
}

export const vaultOperation = async <A>(message: string, run: () => Promise<A>): Promise<A> => {
  try {
    return await run()
  } catch (cause) {
    if (cause instanceof VaultError) throw cause
    throw new VaultError("operation", message, cause)
  }
}

const strict = { onExcessProperty: "error" } as const

export const decodeVaultValue = async <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
  message: string
): Promise<S["Type"]> => {
  try {
    return await Effect.runPromise(Schema.decodeUnknownEffect(schema)(value, strict))
  } catch (cause) {
    throw new VaultError("invalid", message, cause)
  }
}

export const readSecureDocument = (
  vault: CredentialVault | undefined,
  target: SecureDocumentTarget
): Promise<unknown | null> =>
  vaultOperation("Secure credentials could not be read", () =>
    requireVault(vault).readDocument(target)
  )

export const writeSecureDocument = (
  vault: CredentialVault | undefined,
  target: SecureDocumentTarget,
  value: unknown
): Promise<void> =>
  vaultOperation("Secure credentials could not be saved", () =>
    requireVault(vault).writeDocument(target, value)
  )
