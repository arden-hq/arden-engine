import { createServer, type RequestListener, type Server } from "node:http"
import { expect, it } from "vitest"
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"

import { McpOAuthProvider } from "../src/mcp/oauth.js"
import { MCP_PRESETS, mcpPresetCatalog } from "../src/mcp/presets.js"
import { KeyedSerialQueue } from "../src/mcp/serial.js"
import { assertMcpSignInSetUp, createSameOriginFetch } from "../src/mcp/transport.js"
import {
  McpSignInNotSetUp,
  type McpOAuthClientReference,
  type McpOAuthCredentials,
  type McpOAuthVault
} from "../src/mcp/vault.js"

interface HttpFixture {
  readonly origin: string
  readonly close: () => Promise<void>
}

const listen = async (handler: RequestListener): Promise<HttpFixture> => {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("HTTP fixture did not bind")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

it("follows only same-origin redirects for MCP headers and bodies", async () => {
  let targetHits = 0
  const target = await listen((_request, response) => {
    targetHits += 1
    response.writeHead(200).end("unexpected")
  })
  const crossOrigin = await listen((_request, response) => {
    response.writeHead(307, { location: `${target.origin}/stolen` }).end()
  })
  let finalAuthorization = ""
  let finalBody = ""
  const sameOrigin = await listen((request, response) => {
    void (async () => {
      if (request.url === "/start") {
        response.writeHead(307, { location: "/final" }).end()
        return
      }
      finalAuthorization = request.headers.authorization ?? ""
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      finalBody = Buffer.concat(chunks).toString("utf8")
      response.writeHead(200).end("ok")
    })().catch(() => response.destroy())
  })

  try {
    const guardedFetch = createSameOriginFetch()
    await expect(
      guardedFetch(`${crossOrigin.origin}/start`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: '{"private":true}'
      })
    ).rejects.toThrow("different origin")
    expect(targetHits).toBe(0)

    const response = await guardedFetch(`${sameOrigin.origin}/start`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: '{"private":true}'
    })
    expect(await response.text()).toBe("ok")
    expect({ finalAuthorization, finalBody }).toEqual({
      finalAuthorization: "Bearer secret",
      finalBody: '{"private":true}'
    })
  } finally {
    await Promise.all([target.close(), crossOrigin.close(), sameOrigin.close()])
  }
})

it("rejects an MCP HTTP response whose declared body exceeds 16 MiB", async () => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, {
      "content-length": String(16 * 1_024 * 1_024 + 1),
      "content-type": "application/json"
    })
    response.end()
  })

  try {
    const failure = await createSameOriginFetch()(`${fixture.origin}/mcp`).then(
      () => undefined,
      (cause: unknown) => cause
    )
    expect(failure).toMatchObject({
      name: "McpHttpResponseTooLargeError",
      code: "MCP_HTTP_RESPONSE_TOO_LARGE",
      reason: "declared_length",
      observedBytes: 16 * 1_024 * 1_024 + 1,
      message: expect.stringContaining("return a smaller result or a resource link")
    })
  } finally {
    await fixture.close()
  }
})

it("stops a chunked MCP HTTP response after 16 MiB", async () => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    const chunk = Buffer.alloc(1_024 * 1_024, 97)
    for (let index = 0; index < 17; index += 1) response.write(chunk)
    response.end()
  })

  try {
    const response = await createSameOriginFetch()(`${fixture.origin}/mcp`)
    const failure = await response.arrayBuffer().then(
      () => undefined,
      (cause: unknown) => cause
    )
    expect(failure).toMatchObject({
      name: "McpHttpResponseTooLargeError",
      code: "MCP_HTTP_RESPONSE_TOO_LARGE",
      reason: "streamed_bytes",
      observedBytes: expect.any(Number),
      message: expect.stringContaining("return a smaller result or a resource link")
    })
    expect(failure).toHaveProperty(
      "observedBytes",
      expect.toSatisfy((bytes: number) => bytes > 16 * 1_024 * 1_024)
    )
  } finally {
    await fixture.close()
  }
})

it("keeps confidential preset identity in the vault and arbitrary MCP policy conservative", async () => {
  let stored: McpOAuthCredentials | undefined
  let resolved: McpOAuthClientReference | undefined
  const vault: McpOAuthVault = {
    read: async () => stored ?? null,
    write: async (_target, credentials) => {
      stored = structuredClone(credentials)
    },
    clear: async () => {
      stored = undefined
    },
    resolveClient: async (reference) => {
      resolved = reference
      return { clientId: "static-client-id", clientSecret: "static-client-secret" }
    },
    readTransportSecrets: async () => null,
    writeTransportSecrets: async () => undefined,
    clearTransportSecrets: async () => undefined,
    readDocument: async () => null,
    writeDocument: async () => undefined,
    clearDocument: async () => undefined
  }
  const preset = MCP_PRESETS.slack
  await assertMcpSignInSetUp(
    {
      name: "slack",
      presetId: "slack",
      enabled: true,
      transport: {
        type: "http",
        url: preset.servers[0].url,
        auth: "oauth",
        headerKeys: []
      }
    },
    vault
  )
  expect(resolved).toEqual({
    clientIdReference: "mcp.slack.client-id",
    clientSecretReference: "mcp.slack.client-secret"
  })
  const provider = new McpOAuthProvider({
    target: {
      credentialKey: preset.auth.credentialKey,
      binding: "preset:slack"
    },
    vault,
    staticOAuth: preset.auth,
    credentials: new KeyedSerialQueue(),
    onAuthorization: () => undefined,
    beforeIdentityReplacement: () => Promise.resolve()
  })

  expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
  expect(provider.clientMetadata.scope).toBe(preset.auth.scopes.join(" "))
  expect(await provider.clientInformation()).toEqual({
    client_id: "static-client-id",
    client_secret: "static-client-secret",
    issuer: "https://mcp.slack.com/",
    token_endpoint_auth_method: "client_secret_post"
  })
  expect(resolved).toEqual({
    clientIdReference: "mcp.slack.client-id",
    clientSecretReference: "mcp.slack.client-secret"
  })
  const discovery = {
    authorizationServerUrl: "https://mcp.slack.com",
    authorizationServerMetadata: {
      issuer: "https://mcp.slack.com",
      authorization_endpoint: "https://slack.com/oauth/v2_user/authorize",
      token_endpoint: "https://slack.com/api/oauth.v2.user.access",
      response_types_supported: ["code"]
    }
  }
  const resourceMetadata = {
    resource: "https://mcp.slack.com",
    authorization_servers: ["https://mcp.slack.com"]
  }
  expect(
    await auth(provider, {
      serverUrl: "https://mcp.slack.com/mcp",
      scope: preset.auth.scopes.join(" "),
      fetchFn: async (input) =>
        Response.json(
          String(input).includes("oauth-protected-resource")
            ? resourceMetadata
            : discovery.authorizationServerMetadata
        )
    })
  ).toBe("REDIRECT")
  expect(await provider.discoveryState()).toEqual({ ...discovery, resourceMetadata })
  await expect(
    provider.saveDiscoveryState({
      ...discovery,
      authorizationServerUrl: "https://other.example.com"
    })
  ).rejects.toThrow("issuer")
  await provider.saveTokens({ access_token: "access-token", token_type: "Bearer" })
  expect(stored?.tokens?.access_token).toBe("access-token")
  await provider.saveTokens({
    access_token: "access-token",
    token_type: "Bearer",
    refresh_token: "refresh-token"
  })
  expect(await provider.tokens()).toEqual({
    access_token: "access-token",
    token_type: "Bearer",
    refresh_token: "refresh-token",
    issuer: "https://mcp.slack.com/"
  })
  expect(JSON.stringify(stored)).not.toContain("static-client-secret")
  expect(JSON.stringify(mcpPresetCatalog())).not.toMatch(
    /client.?reference|client.?secret|credential.?key/i
  )

  await provider.invalidateCredentials("discovery")
  provider.saveCodeVerifier("test-verifier")
  const tokenRequests: Array<string> = []
  await expect(
    auth(provider, {
      serverUrl: "https://mcp.slack.com/mcp",
      resourceMetadataUrl: new URL("https://mcp.slack.com/.well-known/oauth-protected-resource"),
      authorizationCode: "test-code",
      fetchFn: async (input, init) => {
        if (init?.method === "POST") {
          tokenRequests.push(String(init.body))
          return Response.json({ access_token: "stolen-token", token_type: "Bearer" })
        }
        return Response.json(
          String(input).includes("oauth-protected-resource")
            ? {
                resource: "https://mcp.slack.com/mcp",
                authorization_servers: ["https://attacker.example"]
              }
            : {
                issuer: "https://attacker.example",
                authorization_endpoint: "https://attacker.example/authorize",
                token_endpoint: "https://attacker.example/token",
                response_types_supported: ["code"]
              }
        )
      }
    })
  ).rejects.toThrow("issuer")
  expect(tokenRequests).toEqual([])
})

it("names a confidential preset with no sign-in app as not set up, before any network call", async () => {
  let resolves = 0
  const vault: McpOAuthVault = {
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
    resolveClient: async () => {
      resolves += 1
      return null
    },
    readTransportSecrets: async () => null,
    writeTransportSecrets: async () => undefined,
    clearTransportSecrets: async () => undefined,
    readDocument: async () => null,
    writeDocument: async () => undefined,
    clearDocument: async () => undefined
  }
  const preset = (presetId: "slack" | "linear", url: string) => ({
    name: presetId,
    presetId,
    enabled: true,
    transport: { type: "http" as const, url, auth: "oauth" as const, headerKeys: [] }
  })
  const slack = preset("slack", MCP_PRESETS.slack.servers[0].url)

  await expect(assertMcpSignInSetUp(slack, vault)).rejects.toBeInstanceOf(McpSignInNotSetUp)
  await assertMcpSignInSetUp(preset("linear", MCP_PRESETS.linear.servers[0].url), vault)
  expect(resolves).toBe(1)
})

it("requires an issuer before reusing a dynamic OAuth registration", async () => {
  let credentials: McpOAuthCredentials = {
    client_information: {
      client_id: "dynamic-client",
      redirect_uris: ["http://127.0.0.1:9999/callback"]
    }
  }
  const vault: McpOAuthVault = {
    read: async () => credentials,
    write: async () => undefined,
    clear: async () => undefined,
    resolveClient: async () => null,
    readTransportSecrets: async () => null,
    writeTransportSecrets: async () => undefined,
    clearTransportSecrets: async () => undefined,
    readDocument: async () => null,
    writeDocument: async () => undefined,
    clearDocument: async () => undefined
  }
  const provider = new McpOAuthProvider({
    target: { credentialKey: "dynamic", binding: "dynamic" },
    vault,
    credentials: new KeyedSerialQueue(),
    onAuthorization: () => undefined,
    beforeIdentityReplacement: async () => undefined
  })
  expect(await provider.clientInformation()).toBeUndefined()
  credentials = {
    client_information: {
      client_id: "dynamic-client",
      redirect_uris: ["http://127.0.0.1:9999/callback"],
      issuer: "https://auth.example"
    }
  }
  expect(await provider.clientInformation()).toEqual({
    client_id: "dynamic-client",
    redirect_uris: ["http://127.0.0.1:9999/callback"],
    issuer: "https://auth.example"
  })
})
