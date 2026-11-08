import { auth } from "@modelcontextprotocol/sdk/client/auth.js"

import { closeMcpClient } from "./client.js"
import { McpOAuthCallbacks, McpOAuthProvider } from "./oauth.js"
import { cancelRetry, type McpRuntime, type RuntimeEntry } from "./runtime.js"
import type { KeyedSerialQueue } from "./serial.js"
import {
  assertMcpSignInSetUp,
  createSameOriginFetch,
  mcpOAuthVaultTarget,
  mcpStaticOAuth
} from "./transport.js"
import type { McpOAuthVault } from "./vault.js"

interface PendingOAuth {
  readonly provider: McpOAuthProvider
  readonly state: string
}

export interface McpAuthorizationStart {
  readonly name: string
  readonly authorization_url: string | null
  readonly status: "connected" | "pending"
}

export const makeMcpAuthorization = ({
  runtime,
  vault,
  credentials,
  operations,
  callbacks = new McpOAuthCallbacks()
}: {
  readonly runtime: McpRuntime
  readonly vault: McpOAuthVault | undefined
  readonly credentials: KeyedSerialQueue
  readonly operations: KeyedSerialQueue
  readonly callbacks?: McpOAuthCallbacks
}) => {
  const pendingOAuth = new Map<string, PendingOAuth>()

  const cancel = async (name: string): Promise<void> => {
    callbacks.cancel(name)
    pendingOAuth.delete(name)
  }

  const start = async (current: RuntimeEntry, url: string): Promise<McpAuthorizationStart> => {
    const name = current.config.name
    await assertMcpSignInSetUp(current.config, vault)
    await callbacks.start()
    await cancel(name)
    cancelRetry(current)
    const authorizationEntry = runtime.reset(current.config, "needs_auth")
    await closeMcpClient(current)

    let authorizationUrl: URL | undefined
    const staticOAuth = mcpStaticOAuth(current.config)
    const provider = new McpOAuthProvider({
      target: mcpOAuthVaultTarget(current.config),
      ...(vault === undefined ? {} : { vault }),
      ...(staticOAuth === undefined ? {} : { staticOAuth }),
      credentials,
      onAuthorization: (next) => {
        authorizationUrl = next
      },
      beforeIdentityReplacement: () => runtime.replaceCredentialIdentity(current.config, "oauth")
    })
    await provider.prepareInteractiveAuthorization()
    const options = {
      serverUrl: url,
      ...(staticOAuth === undefined ? {} : { scope: staticOAuth.scopes.join(" ") }),
      fetchFn: createSameOriginFetch()
    }
    const result = await auth(provider, options)
    if (result === "AUTHORIZED") {
      await provider.commitInteractiveAuthorization()
      const connected = await runtime.connectNow(current.config)
      return {
        name,
        authorization_url: null,
        status: connected.status === "connected" ? "connected" : "pending"
      }
    }
    if (authorizationUrl === undefined) throw new Error("MCP sign-in returned no authorization URL")
    const state = await provider.state()
    const pending = { provider, state } satisfies PendingOAuth
    pendingOAuth.set(name, pending)
    const releasePending = async () => {
      if (pendingOAuth.get(name) !== pending) return
      pendingOAuth.delete(name)
    }
    callbacks.register(
      state,
      name,
      (code) =>
        operations.run(name, async () => {
          if (pendingOAuth.get(name) !== pending) return
          try {
            const result = await auth(provider, { ...options, authorizationCode: code })
            if (result !== "AUTHORIZED") throw new Error("MCP sign-in did not authorize Arden")
            await provider.commitInteractiveAuthorization()
          } finally {
            await releasePending()
          }
          const latest = runtime.get(name)
          if (latest !== authorizationEntry || !latest.config.enabled) return
          await runtime.connectNow(latest.config)
          runtime.reconnectPresetSiblings(latest.config)
        }),
      () => operations.run(name, releasePending)
    )
    return {
      name,
      authorization_url: authorizationUrl.toString(),
      status: "pending"
    }
  }

  return {
    start,
    cancel,
    close: async (): Promise<void> => {
      await callbacks.close()
      pendingOAuth.clear()
    }
  }
}
