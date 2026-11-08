import { describe, expect, it } from "vitest"
import { createCredentialVaultBridge } from "../src/daemon-credential-vault.js"

const oauthTarget = {
  credentialKey: "preset:slack",
  binding: "preset:slack"
}
const clientReference = {
  clientIdReference: "mcp.slack.client-id",
  clientSecretReference: "mcp.slack.client-secret"
}
const transportTarget = {
  secretKey: "transport:private_server",
  binding: "server:private_server"
}

const requireRequest = (value: unknown): { readonly requestId: string } => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string"
  )
    throw new Error("Missing broker request")
  return { requestId: value.requestId }
}

describe("daemon credential vault bridge", () => {
  it("maps all secure-owner operations to bounded utility messages", async () => {
    const messages: Array<unknown> = []
    const bridge = createCredentialVaultBridge({ postMessage: (message) => messages.push(message) })

    const read = bridge.vault.read(oauthTarget)
    expect(messages[0]).toMatchObject({
      type: "credential_vault_request",
      operation: "read",
      target: oauthTarget
    })
    bridge.handleMessage({
      type: "credential_vault_response",
      requestId: requireRequest(messages[0]).requestId,
      ok: true,
      value: { tokens: { access_token: "oauth-secret" } }
    })
    await expect(read).resolves.toEqual({ tokens: { access_token: "oauth-secret" } })

    const write = bridge.vault.write(oauthTarget, {
      tokens: { access_token: "replacement-secret" }
    })
    expect(messages[1]).toMatchObject({
      type: "credential_vault_request",
      operation: "write",
      target: oauthTarget,
      credentials: { tokens: { access_token: "replacement-secret" } }
    })
    bridge.handleMessage({
      type: "credential_vault_response",
      requestId: requireRequest(messages[1]).requestId,
      ok: true,
      value: null
    })
    await expect(write).resolves.toBeUndefined()

    const operations = [
      { promise: bridge.vault.clear(oauthTarget), operation: "clear" },
      { promise: bridge.vault.resolveClient(clientReference), operation: "resolve_client" },
      {
        promise: bridge.vault.readTransportSecrets(transportTarget),
        operation: "read_transport_secrets"
      },
      {
        promise: bridge.vault.writeTransportSecrets(transportTarget, { TOKEN: "transport-secret" }),
        operation: "write_transport_secrets"
      },
      {
        promise: bridge.vault.clearTransportSecrets(transportTarget),
        operation: "clear_transport_secrets"
      },
      {
        promise: bridge.vault.writeDocument(
          { documentKey: "google:accounts", binding: "google:v1" },
          { accounts: [] }
        ),
        operation: "write_document"
      }
    ]
    for (const [index, operation] of operations.entries()) {
      const message = messages[index + 2]
      expect(message).toMatchObject({
        type: "credential_vault_request",
        operation: operation.operation
      })
      bridge.handleMessage({
        type: "credential_vault_response",
        requestId: requireRequest(message).requestId,
        ok: true,
        value: null
      })
    }
    await expect(Promise.all(operations.map((operation) => operation.promise))).resolves.toEqual([
      undefined,
      null,
      null,
      undefined,
      undefined,
      undefined
    ])
    bridge.close()
  })

  it("fails closed on invalid, failed, oversized, and late broker responses", async () => {
    const messages: Array<unknown> = []
    const bridge = createCredentialVaultBridge(
      { postMessage: (message) => messages.push(message) },
      { timeoutMs: 1_000 }
    )

    const failed = bridge.vault.resolveClient(clientReference)
    bridge.handleMessage({
      type: "credential_vault_response",
      requestId: requireRequest(messages[0]).requestId,
      ok: false
    })
    await expect(failed).rejects.toThrow("broker failed")

    const invalid = bridge.vault.read(oauthTarget)
    bridge.handleMessage({
      type: "credential_vault_response",
      requestId: requireRequest(messages[1]).requestId,
      ok: true,
      value: null,
      secretDetail: "must-not-pass"
    })
    await expect(invalid).rejects.toThrow("broker failed")

    const oversized = bridge.vault.read(oauthTarget)
    bridge.handleMessage({
      type: "credential_vault_response",
      requestId: requireRequest(messages[2]).requestId,
      ok: true,
      value: "x".repeat(700 * 1_024)
    })
    await expect(oversized).rejects.toThrow("broker failed")

    const pending = bridge.vault.read(oauthTarget)
    bridge.close()
    await expect(pending).rejects.toThrow("broker is closed")
    await expect(bridge.vault.read(oauthTarget)).rejects.toThrow("broker is closed")
    expect(bridge.handleMessage({ type: "unrelated" })).toBe(false)
  })
})
