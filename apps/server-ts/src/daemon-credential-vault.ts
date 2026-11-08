import { Schema } from "effect"
import type {
  McpOAuthClientReference,
  McpOAuthCredentials,
  McpOAuthVault,
  McpOAuthVaultTarget,
  McpTransportSecretTarget
} from "./mcp/vault.js"
import type { SecureDocumentTarget } from "./credentials/vault.js"
import {
  createParentPortRpc,
  type ParentPortFailure,
  type ParentPortResponse,
  type ParentPortSender
} from "./runtime/parent-port-rpc.js"

const DEFAULT_TIMEOUT_MS = 35_000
const MAX_RESPONSE_BYTES = 640 * 1_024
const strict = { onExcessProperty: "error" } as const

export interface CredentialVaultBridge {
  readonly vault: McpOAuthVault
  readonly handleMessage: (input: unknown) => boolean
  readonly close: () => void
}

const RequestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/)
)
const ResponseHeaderSchema = Schema.Struct({
  type: Schema.Literal("credential_vault_response"),
  requestId: RequestIdSchema
})
const ResponseSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("credential_vault_response"),
    requestId: RequestIdSchema,
    ok: Schema.Literal(true),
    value: Schema.NullOr(Schema.Json)
  }),
  Schema.Struct({
    type: Schema.Literal("credential_vault_response"),
    requestId: RequestIdSchema,
    ok: Schema.Literal(false)
  })
])
const decodeResponseHeader = Schema.decodeUnknownSync(ResponseHeaderSchema)
const decodeResponse = Schema.decodeUnknownSync(ResponseSchema)

export const createCredentialVaultBridge = (
  parentPort: ParentPortSender,
  options?: { readonly timeoutMs?: number }
): CredentialVaultBridge => {
  const rpc = createParentPortRpc(parentPort, {
    type: "credential_vault_request",
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    decode: decodeVaultResponse
  })
  let closed = false

  const request = (operation: Readonly<Record<string, unknown>>): Promise<unknown | null> =>
    closed
      ? Promise.reject(new Error("The credential vault broker is closed"))
      : rpc.request(operation, { fail: vaultFailure })

  const requestVoid = async (operation: Readonly<Record<string, unknown>>): Promise<void> => {
    await request(operation)
  }

  const vault: McpOAuthVault = {
    read: (target: McpOAuthVaultTarget) => request({ operation: "read", target }),
    write: (target: McpOAuthVaultTarget, credentials: McpOAuthCredentials) =>
      requestVoid({ operation: "write", target, credentials }),
    clear: (target: McpOAuthVaultTarget) => requestVoid({ operation: "clear", target }),
    resolveClient: (reference: McpOAuthClientReference) =>
      request({ operation: "resolve_client", reference }),
    readTransportSecrets: (target: McpTransportSecretTarget) =>
      request({ operation: "read_transport_secrets", target }),
    writeTransportSecrets: (
      target: McpTransportSecretTarget,
      secrets: Readonly<Record<string, string>>
    ) => requestVoid({ operation: "write_transport_secrets", target, secrets }),
    clearTransportSecrets: (target: McpTransportSecretTarget) =>
      requestVoid({ operation: "clear_transport_secrets", target }),
    readDocument: (target: SecureDocumentTarget) => request({ operation: "read_document", target }),
    writeDocument: (target: SecureDocumentTarget, value: unknown) =>
      requestVoid({ operation: "write_document", target, value }),
    clearDocument: (target: SecureDocumentTarget) =>
      requestVoid({ operation: "clear_document", target })
  }

  const close = (): void => {
    if (closed) return
    closed = true
    rpc.abortAll()
  }

  return { vault, handleMessage: rpc.handleMessage, close }
}

const vaultFailure = (failure: ParentPortFailure<undefined>): Error => {
  switch (failure.kind) {
    case "timeout":
      return new Error("The credential vault broker timed out")
    case "stopped":
      return new Error("The credential vault broker is closed")
    case "aborted":
    case "dispatch_failed":
    case "invalid_response":
    case "rejected":
      return new Error("The credential vault broker failed")
  }
}

const decodeVaultResponse = (
  input: unknown
): ParentPortResponse<unknown | null, undefined> | undefined => {
  let header: typeof ResponseHeaderSchema.Type
  try {
    header = decodeResponseHeader(input)
  } catch {
    return undefined
  }
  if (serializedSize(input) > MAX_RESPONSE_BYTES)
    return { kind: "invalid", requestId: header.requestId }
  let message: typeof ResponseSchema.Type
  try {
    message = decodeResponse(input, strict)
  } catch {
    return { kind: "invalid", requestId: header.requestId }
  }
  return message.ok
    ? { kind: "value", requestId: message.requestId, value: message.value }
    : { kind: "error", requestId: message.requestId, error: undefined }
}

const serializedSize = (input: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(input), "utf8")
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
