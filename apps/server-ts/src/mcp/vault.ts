import { Predicate, Schema } from "effect"

import {
  decodeVaultValue,
  requireVault,
  VaultError,
  vaultOperation,
  type CredentialVault
} from "../credentials/vault.js"

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json)
const MAX_ACCOUNT_IDENTITY_LENGTH = 512

const McpOAuthCredentialsSchema = Schema.Struct({
  tokens: Schema.optionalKey(JsonRecordSchema),
  client_information: Schema.optionalKey(JsonRecordSchema),
  discovery: Schema.optionalKey(JsonRecordSchema)
})

export type McpOAuthCredentials = typeof McpOAuthCredentialsSchema.Type

const McpOAuthStaticClientSchema = Schema.Struct({
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
  clientSecret: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))
})

export interface McpOAuthVaultTarget {
  readonly credentialKey: string
  readonly binding: string
}

export interface McpOAuthClientReference {
  readonly clientIdReference: string
  readonly clientSecretReference: string
}

export interface McpOAuthStaticClient {
  readonly clientId: string
  readonly clientSecret: string
}

export interface McpTransportSecretTarget {
  readonly secretKey: string
  readonly binding: string
}

/**
 * The host vault: generic documents plus the MCP OAuth and transport-secret
 * operations, whose shapes the Electron main process checks itself.
 */
export interface McpOAuthVault extends CredentialVault {
  readonly read: (target: McpOAuthVaultTarget) => Promise<unknown | null>
  readonly write: (target: McpOAuthVaultTarget, credentials: McpOAuthCredentials) => Promise<void>
  readonly clear: (target: McpOAuthVaultTarget) => Promise<void>
  readonly resolveClient: (reference: McpOAuthClientReference) => Promise<unknown | null>
  readonly readTransportSecrets: (target: McpTransportSecretTarget) => Promise<unknown | null>
  readonly writeTransportSecrets: (
    target: McpTransportSecretTarget,
    secrets: Readonly<Record<string, string>>
  ) => Promise<void>
  readonly clearTransportSecrets: (target: McpTransportSecretTarget) => Promise<void>
}

const STORAGE = "MCP credential"

export class McpSignInNotSetUp extends Error {
  constructor() {
    super("MCP OAuth client identity is not configured")
    this.name = "McpSignInNotSetUp"
  }
}

export const MCP_CREDENTIALS_UNREADABLE =
  "Arden couldn’t read secure app credentials. Try restarting Arden."

export const readMcpOAuthCredentials = async (
  vault: McpOAuthVault | undefined,
  target: McpOAuthVaultTarget
): Promise<McpOAuthCredentials> => {
  const owner = requireVault(vault, STORAGE)
  const value = await vaultOperation("Secure MCP OAuth credentials could not be read", () =>
    owner.read(target)
  )
  if (value === null) return {}
  return decodeVaultValue(
    McpOAuthCredentialsSchema,
    value,
    "Secure MCP OAuth credentials are invalid"
  )
}

const displayIdentity = (value: unknown): string | undefined => {
  if (!Predicate.isString(value)) return undefined
  const identity = value.trim()
  return identity.length > 0 &&
    identity.length <= MAX_ACCOUNT_IDENTITY_LENGTH &&
    !/[\u0000-\u001F\u007F]/u.test(identity)
    ? identity
    : undefined
}

const recordIdentity = (value: unknown): string | undefined => {
  if (!Schema.is(JsonRecordSchema)(value)) return undefined
  return (
    displayIdentity(value.email) ??
    displayIdentity(value.preferred_username) ??
    displayIdentity(value.name)
  )
}

const jwtIdentity = (value: unknown): string | undefined => {
  if (!Predicate.isString(value) || value.length > 65_536) return undefined
  const payload = value.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return recordIdentity(decoded)
  } catch {
    return undefined
  }
}

export const readMcpOAuthAccountIdentity = async (
  vault: McpOAuthVault | undefined,
  target: McpOAuthVaultTarget
): Promise<string | null> => {
  const tokens = (await readMcpOAuthCredentials(vault, target)).tokens
  if (tokens === undefined) return null
  const nested =
    recordIdentity(tokens.user) ??
    recordIdentity(tokens.authed_user) ??
    recordIdentity(tokens.account)
  const team = Schema.is(JsonRecordSchema)(tokens.team)
    ? displayIdentity(tokens.team.name)
    : undefined
  return recordIdentity(tokens) ?? jwtIdentity(tokens.id_token) ?? nested ?? team ?? null
}

export const writeMcpOAuthCredentials = async (
  vault: McpOAuthVault | undefined,
  target: McpOAuthVaultTarget,
  credentials: McpOAuthCredentials
): Promise<void> => {
  const owner = requireVault(vault, STORAGE)
  await vaultOperation("Secure MCP OAuth credentials could not be saved", () =>
    owner.write(target, credentials)
  )
}

export const clearMcpOAuthCredentials = async (
  vault: McpOAuthVault | undefined,
  target: McpOAuthVaultTarget
): Promise<void> => {
  if (vault === undefined) return
  await vaultOperation("Secure MCP OAuth credentials could not be cleared", () =>
    vault.clear(target)
  )
}

export const resolveMcpOAuthClient = async (
  vault: McpOAuthVault | undefined,
  reference: McpOAuthClientReference
): Promise<McpOAuthStaticClient> => {
  const owner = requireVault(vault, STORAGE)
  const value = await vaultOperation("MCP OAuth client identity could not be read", () =>
    owner.resolveClient(reference)
  )
  if (value === null) throw new McpSignInNotSetUp()
  return decodeVaultValue(McpOAuthStaticClientSchema, value, "MCP OAuth client identity is invalid")
}

const McpTransportSecretsSchema = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)),
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))
)

export const readMcpTransportSecrets = async (
  vault: McpOAuthVault | undefined,
  target: McpTransportSecretTarget,
  keys: ReadonlyArray<string>
): Promise<Readonly<Record<string, string>>> => {
  if (keys.length === 0) return {}
  const owner = requireVault(vault, STORAGE)
  const value = await vaultOperation("Secure MCP transport secrets could not be read", () =>
    owner.readTransportSecrets(target)
  )
  if (value === null) {
    throw new VaultError("unavailable", "Secure MCP transport secrets are unavailable")
  }
  const secrets = await decodeVaultValue(
    McpTransportSecretsSchema,
    value,
    "Secure MCP transport secrets are invalid"
  )
  const selected = Object.fromEntries(
    keys.map((key) => {
      const secret = secrets[key]
      if (secret === undefined) {
        throw new VaultError("invalid", `Secure MCP transport secret ${key} is missing`)
      }
      return [key, secret]
    })
  )
  return selected
}

export const writeMcpTransportSecrets = async (
  vault: McpOAuthVault | undefined,
  target: McpTransportSecretTarget,
  secrets: Readonly<Record<string, string>>
): Promise<void> => {
  if (Object.keys(secrets).length === 0) {
    await clearMcpTransportSecrets(vault, target)
    return
  }
  const owner = requireVault(vault, STORAGE)
  const validated = await decodeVaultValue(
    McpTransportSecretsSchema,
    secrets,
    "Secure MCP transport secrets are invalid"
  )
  await vaultOperation("Secure MCP transport secrets could not be saved", () =>
    owner.writeTransportSecrets(target, validated)
  )
}

export const clearMcpTransportSecrets = async (
  vault: McpOAuthVault | undefined,
  target: McpTransportSecretTarget
): Promise<void> => {
  if (vault === undefined) return
  await vaultOperation("Secure MCP transport secrets could not be cleared", () =>
    vault.clearTransportSecrets(target)
  )
}
