import { mcpOAuthClientReferences } from "@arden-hq/protocol/mcp"
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpOAuthProvider, type McpOAuthCallbacks } from "./oauth.js"
import { KeyedSerialQueue } from "./serial.js"
import { clearMcpOAuthCredentials, resolveMcpOAuthClient, type McpOAuthVault } from "./vault.js"
import { createSameOriginFetch } from "./transport.js"

const serverUrl = "https://api.githubcopilot.com/mcp"
const resourceMetadataUrl = new URL(
  "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp"
)
const target = { credentialKey: "preset:github", binding: "preset:github" }

export const makeGitHubOAuth = ({
  vault,
  credentials,
  callbacks,
  operations,
  fetch = createSameOriginFetch()
}: {
  readonly vault: McpOAuthVault | undefined
  readonly credentials: KeyedSerialQueue
  readonly callbacks: Pick<McpOAuthCallbacks, "start" | "register" | "cancel">
  readonly operations: KeyedSerialQueue
  readonly fetch?: FetchLike
}) => {
  let pending: { readonly controller: AbortController } | undefined
  const provider = (onAuthorization: (url: URL) => void, beforeCommit: () => Promise<void>) =>
    new McpOAuthProvider({
      target,
      ...(vault === undefined ? {} : { vault }),
      credentials,
      staticOAuth: {
        credentialKey: target.credentialKey,
        clientType: "confidential",
        expectedIssuer: "https://github.com/login/oauth",
        ...mcpOAuthClientReferences.github,
        scopes: ["offline_access"]
      },
      onAuthorization,
      beforeIdentityReplacement: beforeCommit
    })
  const trustedFetch =
    (signal?: AbortSignal): FetchLike =>
    (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (
        url.protocol !== "https:" ||
        !["github.com", "api.githubcopilot.com"].includes(url.hostname)
      )
        throw new Error("GitHub sign-in advertised an untrusted endpoint")
      return fetch(input, {
        ...init,
        signal:
          signal === undefined
            ? AbortSignal.timeout(10_000)
            : AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      })
    }
  const persistent = provider(
    () => undefined,
    async () => undefined
  )
  const cancel = (): void => {
    callbacks.cancel("github")
    pending?.controller.abort()
    pending = undefined
  }
  return {
    cancel,
    hasGrant: async (): Promise<boolean> => (await persistent.tokens()) !== undefined,
    token: (): Promise<string | undefined> =>
      credentials.run("github:refresh", async () => {
        const tokens = await persistent.tokens()
        if (tokens === undefined) return undefined
        if (tokens.expires_in === undefined || tokens.expires_in > 60) return tokens.access_token
        if (tokens.refresh_token === undefined) return undefined
        const result = await auth(persistent, {
          serverUrl,
          resourceMetadataUrl,
          scope: "offline_access",
          fetchFn: trustedFetch()
        })
        if (result !== "AUTHORIZED") return undefined
        return (await persistent.tokens())?.access_token
      }),
    clear: async (): Promise<void> => {
      cancel()
      await credentials.run("github:refresh", () =>
        credentials.run(target.credentialKey, () => clearMcpOAuthCredentials(vault, target))
      )
    },
    start: async ({
      beforeCommit,
      onConnected,
      onFailure
    }: {
      readonly beforeCommit: () => Promise<void>
      readonly onConnected: () => Promise<void>
      readonly onFailure: () => Promise<void>
    }): Promise<string> => {
      await resolveMcpOAuthClient(vault, mcpOAuthClientReferences.github)
      await callbacks.start()
      cancel()
      const controller = new AbortController()
      let authorizationUrl: URL | undefined
      const interactive = provider((url) => {
        if (url.origin !== "https://github.com")
          throw new Error("GitHub sign-in has an untrusted destination")
        authorizationUrl = url
      }, beforeCommit)
      const request = { controller }
      pending = request
      try {
        await interactive.prepareInteractiveAuthorization()
        await auth(interactive, {
          serverUrl,
          resourceMetadataUrl,
          scope: "offline_access",
          fetchFn: trustedFetch(controller.signal)
        })
        if (authorizationUrl === undefined || pending !== request)
          throw new Error("GitHub sign-in could not start")
        callbacks.register(
          await interactive.state(),
          "github",
          (code) =>
            operations.run("github", async () => {
              if (pending !== request) return
              try {
                await auth(interactive, {
                  serverUrl,
                  resourceMetadataUrl,
                  scope: "offline_access",
                  authorizationCode: code,
                  fetchFn: trustedFetch(controller.signal)
                })
                if (pending !== request) return
                await credentials.run("github:refresh", () =>
                  interactive.commitInteractiveAuthorization()
                )
                pending = undefined
                await onConnected()
              } catch {
                if (pending !== request) return
                pending = undefined
                await onFailure()
              }
            }),
          () =>
            operations.run("github", async () => {
              if (pending !== request) return
              cancel()
              await onFailure()
            })
        )
        return authorizationUrl.toString()
      } catch (cause) {
        if (pending === request) cancel()
        throw cause
      }
    }
  }
}
