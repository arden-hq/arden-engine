import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { makeGitHubOAuth } from "../src/mcp/github-oauth.js"
import { makeGitHubConnection } from "../src/mcp/github-connection.js"
import type { McpOAuthCallbacks } from "../src/mcp/oauth.js"
import { KeyedSerialQueue } from "../src/mcp/serial.js"
import type { McpOAuthVault } from "../src/mcp/vault.js"

const ACCESS = "ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const REFRESHED = "ghu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const REFRESH = "ghr_cccccccccccccccccccccccccccccccccccccccc"

function fixture({
  tokenReply,
  issuer = "https://github.com/login/oauth"
}: {
  tokenReply: (body: URLSearchParams) => Promise<Response>
  issuer?: string
}) {
  const documents = new Map<string, unknown>()
  const vault: McpOAuthVault = {
    readDocument: async (target) => documents.get(target.documentKey) ?? null,
    writeDocument: async (target, value) => {
      documents.set(target.documentKey, structuredClone(value))
    },
    clearDocument: async (target) => {
      documents.delete(target.documentKey)
    },
    read: async (target) => documents.get(target.credentialKey) ?? null,
    write: async (target, value) => {
      documents.set(target.credentialKey, structuredClone(value))
    },
    clear: async (target) => {
      documents.delete(target.credentialKey)
    },
    resolveClient: async () => ({ clientId: "Iv-test-app", clientSecret: "test-client-secret" }),
    readTransportSecrets: async () => null,
    writeTransportSecrets: async () => undefined,
    clearTransportSecrets: async () => undefined
  }
  let complete: ((code: string) => Promise<void>) | undefined
  const callbacks: Pick<McpOAuthCallbacks, "start" | "register" | "cancel"> = {
    start: async () => undefined,
    register: (_state, _name, callback) => {
      complete = callback
    },
    cancel: () => undefined
  }
  const bodies: Array<URLSearchParams> = []
  const oauth = makeGitHubOAuth({
    vault,
    callbacks,
    credentials: new KeyedSerialQueue(),
    operations: new KeyedSerialQueue(),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return Response.json({
          resource: "https://api.githubcopilot.com/mcp",
          authorization_servers: [issuer],
          scopes_supported: ["repo"]
        })
      if (url.pathname.includes(".well-known"))
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/access_token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"]
        })
      if (url.pathname === "/login/oauth/access_token") {
        const body = new URLSearchParams(String(init?.body))
        bodies.push(body)
        return tokenReply(body)
      }
      return new Response(null, { status: 404 })
    }
  })
  const finish = async () => {
    if (complete === undefined) throw new Error("No authorization callback registered")
    await complete("test-code")
  }
  const github = makeGitHubConnection({
    vault,
    oauth
  })
  const start = () =>
    oauth.start({
      beforeCommit: async () => undefined,
      onConnected: () => github.useApp(),
      onFailure: async () => undefined
    })
  return { oauth, github, start, finish, documents, bodies }
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => Response.json({ login: "octocat" }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it("exchanges a PKCE-bound GitHub grant, refreshes it and retains access settings across reconnect", async () => {
  const setup = fixture({
    tokenReply: async (body) =>
      Response.json({
        access_token: body.get("grant_type") === "refresh_token" ? REFRESHED : ACCESS,
        token_type: "bearer",
        expires_in: body.get("grant_type") === "refresh_token" ? 28800 : 0,
        refresh_token: REFRESH,
        scope: ""
      })
  })
  const url = new URL(await setup.start())
  expect(url.origin).toBe("https://github.com")
  expect(url.searchParams.get("scope")).toBe("offline_access")
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  expect(url.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/)
  expect(await setup.github.state()).toEqual({ connection: null })
  await setup.finish()
  expect(setup.bodies[0]?.get("client_secret")).toBe("test-client-secret")
  expect(setup.bodies[0]?.get("client_id")).toBe("Iv-test-app")
  const verifier = setup.bodies[0]?.get("code_verifier")
  expect(typeof verifier).toBe("string")
  expect(url.searchParams.get("code_challenge")).toBe(
    createHash("sha256")
      .update(verifier ?? "")
      .digest("base64url")
  )
  expect(await setup.github.auth.headers()).toEqual({
    Authorization: `Bearer ${REFRESHED}`,
    "X-MCP-Readonly": "true"
  })
  expect(setup.bodies[1]?.get("refresh_token")).toBe(REFRESH)
  expect(await setup.github.token()).toBeUndefined()
  await setup.github.setReadOnly(false)
  const reread = makeGitHubConnection({
    vault: {
      readDocument: async (target) => setup.documents.get(target.documentKey) ?? null,
      writeDocument: async () => undefined,
      clearDocument: async () => undefined
    },
    oauth: setup.oauth
  })
  expect(await reread.state()).toEqual({ connection: { readOnly: false, source: "app" } })
  await setup.github.forget()
  expect(await setup.github.state()).toEqual({ connection: null })
  expect(setup.documents.size).toBe(0)
})

it("a cancelled GitHub exchange cannot restore a removed grant when its network reply arrives late", async () => {
  let release: ((response: Response) => void) | undefined
  let reached: (() => void) | undefined
  const exchanging = new Promise<void>((resolve) => {
    reached = resolve
  })
  const setup = fixture({
    tokenReply: () => {
      reached?.()
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }
  })
  await setup.start()
  const completion = setup.finish()
  await exchanging
  await setup.oauth.clear()
  release?.(Response.json({ access_token: ACCESS, token_type: "bearer" }))
  await completion
  expect(await setup.oauth.hasGrant()).toBe(false)
  expect(setup.documents.size).toBe(0)
})

it("GitHub discovery cannot send app credentials to another issuer", async () => {
  const setup = fixture({
    issuer: "https://attacker.example/oauth",
    tokenReply: async () => Response.json({ access_token: ACCESS, token_type: "bearer" })
  })
  await expect(setup.start()).rejects.toThrow()
  expect(setup.bodies).toEqual([])
  expect(setup.documents.size).toBe(0)
})

it("removal wins over an in-flight refresh and cannot leave the rotated token behind", async () => {
  let release: ((response: Response) => void) | undefined
  let reached: (() => void) | undefined
  const refreshing = new Promise<void>((resolve) => {
    reached = resolve
  })
  const setup = fixture({
    tokenReply: async (body) => {
      if (body.get("grant_type") !== "refresh_token")
        return Response.json({
          access_token: ACCESS,
          token_type: "bearer",
          expires_in: 0,
          refresh_token: REFRESH
        })
      reached?.()
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }
  })
  await setup.start()
  await setup.finish()
  const token = setup.oauth.token()
  await refreshing
  const clearing = setup.oauth.clear()
  release?.(
    Response.json({
      access_token: REFRESHED,
      token_type: "bearer",
      expires_in: 28800,
      refresh_token: REFRESH
    })
  )
  await token
  await clearing
  expect(await setup.oauth.hasGrant()).toBe(false)
  expect(setup.documents.size).toBe(0)
})
