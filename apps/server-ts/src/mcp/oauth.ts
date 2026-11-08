import { mcpOAuthRedirectUri } from "@arden-hq/protocol/mcp"
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  OAuthClientInformationFullSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OAuthTokensSchema
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { serverUrlIssue, type ServerUrlIssue } from "@arden-hq/std/url"
import { Effect, Schema } from "effect"
import { randomBytes } from "node:crypto"

import {
  listenLoopback,
  loopbackRedirectUri,
  type LoopbackListener,
  type LoopbackReply
} from "../connections/loopback-callback.js"
import { KeyedSerialQueue } from "./serial.js"
import type { McpStaticOAuthMetadata } from "./presets.js"
import {
  clearMcpOAuthCredentials,
  readMcpOAuthCredentials,
  resolveMcpOAuthClient,
  writeMcpOAuthCredentials,
  type McpOAuthCredentials,
  type McpOAuthVault,
  type McpOAuthVaultTarget
} from "./vault.js"
import { currentMillis } from "../runtime/clock.js"

const MCP_OAUTH_CALLBACK_PORT = Number(new URL(mcpOAuthRedirectUri).port)
const MCP_OAUTH_CALLBACK_PATH = new URL(mcpOAuthRedirectUri).pathname
const MCP_OAUTH_REDIRECT_URL = loopbackRedirectUri(MCP_OAUTH_CALLBACK_PORT, MCP_OAUTH_CALLBACK_PATH)

const CALLBACK_TIMEOUT_MS = 5 * 60_000
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json)
const TOKEN_ISSUER_KEY = "_arden_issuer"

const toJsonRecord = (value: unknown): Promise<Record<string, Schema.Json>> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(JsonRecordSchema)(value, {
      onExcessProperty: "error"
    })
  )

const without = (
  credentials: McpOAuthCredentials,
  field: keyof McpOAuthCredentials
): McpOAuthCredentials => {
  const next = { ...credentials }
  delete next[field]
  return next
}

const authorizationMetadata = (value: unknown): AuthorizationServerMetadata | undefined => {
  const oauth = OAuthMetadataSchema.safeParse(value)
  if (oauth.success) return oauth.data
  const openId = OpenIdProviderDiscoveryMetadataSchema.safeParse(value)
  return openId.success ? openId.data : undefined
}

const protectedResourceMetadata = (value: unknown): OAuthProtectedResourceMetadata | undefined => {
  const parsed = OAuthProtectedResourceMetadataSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const discoveryState = (value: unknown): OAuthDiscoveryState | undefined => {
  if (!Schema.is(JsonRecordSchema)(value) || typeof value.authorizationServerUrl !== "string") {
    return undefined
  }
  const metadata =
    value.authorizationServerMetadata === undefined
      ? undefined
      : authorizationMetadata(value.authorizationServerMetadata)
  const resource =
    value.resourceMetadata === undefined
      ? undefined
      : protectedResourceMetadata(value.resourceMetadata)
  if (value.authorizationServerMetadata !== undefined && metadata === undefined) return undefined
  if (value.resourceMetadata !== undefined && resource === undefined) return undefined
  if (value.resourceMetadataUrl !== undefined && typeof value.resourceMetadataUrl !== "string") {
    return undefined
  }
  return {
    authorizationServerUrl: value.authorizationServerUrl,
    ...(value.resourceMetadataUrl === undefined
      ? {}
      : { resourceMetadataUrl: value.resourceMetadataUrl }),
    ...(resource === undefined ? {} : { resourceMetadata: resource }),
    ...(metadata === undefined ? {} : { authorizationServerMetadata: metadata })
  }
}

const SECURE_URL_ISSUE: Record<ServerUrlIssue, string> = {
  invalid: "must be an absolute URL",
  credentials: "must not contain credentials",
  fragment: "must not contain a fragment",
  insecure: "must use HTTPS"
}

const secureUrl = (value: string, label: string): URL => {
  const issue = serverUrlIssue(value)
  if (issue !== undefined) throw new Error(`${label} ${SECURE_URL_ISSUE[issue]}`)
  return new URL(value)
}

const validateDiscoveryState = (state: OAuthDiscoveryState): string => {
  secureUrl(state.authorizationServerUrl, "MCP OAuth authorization server")
  if (state.resourceMetadataUrl !== undefined) {
    secureUrl(state.resourceMetadataUrl, "MCP OAuth resource metadata")
  }
  for (const server of state.resourceMetadata?.authorization_servers ?? []) {
    secureUrl(server, "MCP OAuth advertised authorization server")
  }
  const metadata = state.authorizationServerMetadata
  if (metadata === undefined) throw new Error("MCP OAuth discovery did not provide an issuer")
  const issuer = secureUrl(metadata.issuer, "MCP OAuth issuer")
  secureUrl(metadata.authorization_endpoint, "MCP OAuth authorization endpoint")
  secureUrl(metadata.token_endpoint, "MCP OAuth token endpoint")
  if (metadata.registration_endpoint !== undefined) {
    secureUrl(metadata.registration_endpoint, "MCP OAuth registration endpoint")
  }
  if (metadata.issuer !== state.authorizationServerUrl) {
    throw new Error("MCP OAuth issuer does not match the discovered authorization server")
  }
  return issuer.toString()
}

const storedIssuer = (credentials: McpOAuthCredentials): string | undefined => {
  const state = discoveryState(credentials.discovery)
  if (state === undefined) return undefined
  try {
    return validateDiscoveryState(state)
  } catch {
    return undefined
  }
}

const credentialField = (scope: "client" | "tokens" | "discovery"): keyof McpOAuthCredentials => {
  switch (scope) {
    case "client":
      return "client_information"
    case "tokens":
      return "tokens"
    case "discovery":
      return "discovery"
  }
}

type CredentialState =
  | { readonly kind: "persistent" }
  | { readonly kind: "pending"; readonly credentials: McpOAuthCredentials }

export interface McpOAuthProviderOptions {
  readonly target: McpOAuthVaultTarget
  readonly vault?: McpOAuthVault
  readonly staticOAuth?: McpStaticOAuthMetadata
  readonly credentials: KeyedSerialQueue
  readonly onAuthorization: (url: URL) => void
  readonly beforeIdentityReplacement: () => Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = MCP_OAUTH_REDIRECT_URL

  private codeVerifierValue: string | undefined
  private stateValue: string | undefined
  private credentialState: CredentialState = { kind: "persistent" }

  constructor(private readonly options: McpOAuthProviderOptions) {}

  get clientMetadata(): OAuthClientMetadata {
    const oauth = this.options.staticOAuth
    return {
      redirect_uris: [MCP_OAUTH_REDIRECT_URL],
      client_name: "Arden",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: oauth === undefined ? "none" : "client_secret_post",
      ...(oauth === undefined || oauth.scopes.length === 0 ? {} : { scope: oauth.scopes.join(" ") })
    }
  }

  private readStored(): Promise<McpOAuthCredentials> {
    return readMcpOAuthCredentials(this.options.vault, this.options.target)
  }

  private read(): Promise<McpOAuthCredentials> {
    if (this.credentialState.kind === "pending") {
      return Promise.resolve(this.credentialState.credentials)
    }
    return this.options.credentials.run(this.options.target.credentialKey, () => this.readStored())
  }

  private async mutate(
    operation: (
      credentials: McpOAuthCredentials
    ) => McpOAuthCredentials | Promise<McpOAuthCredentials>
  ): Promise<void> {
    if (this.credentialState.kind === "pending") {
      this.credentialState = {
        kind: "pending",
        credentials: await operation(this.credentialState.credentials)
      }
      return
    }
    await this.options.credentials.run(this.options.target.credentialKey, async () => {
      const next = await operation(await this.readStored())
      await writeMcpOAuthCredentials(this.options.vault, this.options.target, next)
    })
  }

  async state(): Promise<string> {
    if (this.stateValue === undefined) this.stateValue = randomBytes(32).toString("hex")
    return this.stateValue
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const staticOAuth = this.options.staticOAuth
    if (staticOAuth !== undefined) {
      const client = await resolveMcpOAuthClient(this.options.vault, {
        clientIdReference: staticOAuth.clientIdReference,
        clientSecretReference: staticOAuth.clientSecretReference
      })
      const information = {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        issuer: secureUrl(staticOAuth.expectedIssuer, "MCP OAuth expected issuer").toString(),
        token_endpoint_auth_method: "client_secret_post" as const
      }
      return information
    }
    const stored = (await this.read()).client_information
    if (stored === undefined) return undefined
    const parsed = OAuthClientInformationFullSchema.safeParse(stored)
    return parsed.success && parsed.data.issuer !== undefined ? parsed.data : undefined
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this.options.staticOAuth !== undefined) {
      throw new Error("Static MCP OAuth clients cannot be replaced by dynamic registration")
    }
    const client = await toJsonRecord(clientInformation)
    await this.mutate((credentials) => ({ ...credentials, client_information: client }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const credentials = await this.read()
    const stored = credentials.tokens
    if (stored === undefined) return undefined
    const value = { ...stored }
    const expiresAt = value._arden_expires_at
    const boundIssuer = value[TOKEN_ISSUER_KEY]
    const refreshToken = value.refresh_token
    const expectedIssuer = this.options.staticOAuth?.expectedIssuer
    delete value._arden_expires_at
    delete value[TOKEN_ISSUER_KEY]
    if (
      typeof refreshToken === "string" &&
      (typeof boundIssuer !== "string" ||
        boundIssuer !== storedIssuer(credentials) ||
        (expectedIssuer !== undefined &&
          boundIssuer !== secureUrl(expectedIssuer, "MCP OAuth expected issuer").toString()))
    ) {
      return undefined
    }
    if (typeof expiresAt === "number") {
      value.expires_in = Math.max(0, Math.floor(expiresAt - currentMillis() / 1_000))
    }
    // Arden's binding predates the SDK's issuer field; expose the same trusted identity.
    const parsed = OAuthTokensSchema.safeParse({
      ...value,
      ...(typeof boundIssuer === "string" ? { issuer: boundIssuer } : {})
    })
    return parsed.success ? parsed.data : undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored = await toJsonRecord(tokens)
    if (typeof tokens.expires_in === "number") {
      stored._arden_expires_at = currentMillis() / 1_000 + tokens.expires_in
    }
    await this.mutate((credentials) => {
      const previousRefreshToken = credentials.tokens?.refresh_token
      if (tokens.refresh_token === undefined && typeof previousRefreshToken === "string") {
        stored.refresh_token = previousRefreshToken
      }
      if (typeof stored.refresh_token === "string") {
        const issuer = storedIssuer(credentials)
        if (issuer === undefined) throw new Error("MCP OAuth refresh token has no bound issuer")
        stored[TOKEN_ISSUER_KEY] = issuer
      }
      return { ...credentials, tokens: stored }
    })
  }

  async prepareInteractiveAuthorization(): Promise<void> {
    const credentials = await this.read()
    const parsedClient =
      credentials.client_information === undefined
        ? undefined
        : OAuthClientInformationFullSchema.safeParse(credentials.client_information)
    const redirectUris =
      parsedClient?.success === true ? parsedClient.data.redirect_uris.map(String) : []
    this.credentialState = {
      kind: "pending",
      credentials: {
        ...(this.options.staticOAuth === undefined &&
        parsedClient?.success === true &&
        parsedClient.data.issuer !== undefined &&
        redirectUris.includes(MCP_OAUTH_REDIRECT_URL)
          ? { client_information: credentials.client_information }
          : {}),
        ...(credentials.discovery === undefined ? {} : { discovery: credentials.discovery })
      }
    }
  }

  async commitInteractiveAuthorization(): Promise<void> {
    if (
      this.credentialState.kind !== "pending" ||
      this.credentialState.credentials.tokens === undefined
    ) {
      throw new Error("MCP OAuth authorization did not return tokens")
    }
    const next = this.credentialState.credentials
    await this.options.beforeIdentityReplacement()
    await this.options.credentials.run(this.options.target.credentialKey, () =>
      writeMcpOAuthCredentials(this.options.vault, this.options.target, next)
    )
    this.credentialState = { kind: "persistent" }
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.options.onAuthorization(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    if (this.codeVerifierValue === undefined) throw new Error("MCP OAuth verifier is unavailable")
    return this.codeVerifierValue
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    if (scope === "all") {
      if (this.credentialState.kind === "pending") {
        this.credentialState = { kind: "pending", credentials: {} }
      } else {
        await this.options.credentials.run(this.options.target.credentialKey, () =>
          clearMcpOAuthCredentials(this.options.vault, this.options.target)
        )
      }
      this.codeVerifierValue = undefined
      this.stateValue = undefined
      return
    }
    if (scope === "verifier") {
      this.codeVerifierValue = undefined
      return
    }
    if (scope === "client" && this.options.staticOAuth !== undefined) return
    await this.mutate((credentials) => without(credentials, credentialField(scope)))
  }

  private validateDiscoveryState(state: OAuthDiscoveryState): void {
    const issuer = validateDiscoveryState(state)
    const expected = this.options.staticOAuth?.expectedIssuer
    if (
      expected !== undefined &&
      issuer !== secureUrl(expected, "MCP OAuth expected issuer").toString()
    ) {
      throw new Error("MCP OAuth issuer does not match the configured preset")
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.validateDiscoveryState(state)
    const discovery = await toJsonRecord({
      authorizationServerUrl: state.authorizationServerUrl,
      ...(state.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: state.resourceMetadataUrl }),
      ...(state.resourceMetadata === undefined ? {} : { resourceMetadata: state.resourceMetadata }),
      ...(state.authorizationServerMetadata === undefined
        ? {}
        : { authorizationServerMetadata: state.authorizationServerMetadata })
    })
    await this.mutate((credentials) => ({ ...credentials, discovery }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = discoveryState((await this.read()).discovery)
    if (state === undefined) return undefined
    try {
      this.validateDiscoveryState(state)
      return state
    } catch {
      return undefined
    }
  }
}

interface PendingCallback {
  readonly name: string
  readonly complete: (code: string) => Promise<void>
  readonly fail: () => Promise<void>
  readonly timeout: ReturnType<typeof setTimeout>
}

const callbackPage = (title: string, detail: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;padding:3rem;background:#171717;color:#f5f5f5">
<h1>${title}</h1><p>${detail}</p></body></html>`

export class McpOAuthCallbacks {
  private listener: LoopbackListener | undefined
  private startPromise: Promise<void> | undefined
  private readonly pending = new Map<string, PendingCallback>()

  async start(): Promise<void> {
    if (this.listener !== undefined) return
    if (this.startPromise !== undefined) return this.startPromise
    const startPromise = this.listen()
    this.startPromise = startPromise
    try {
      await startPromise
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined
    }
  }

  private async listen(): Promise<void> {
    const page = (status: number, title: string, detail: string): LoopbackReply => ({
      status,
      type: "html",
      body: callbackPage(title, detail)
    })
    let listener: LoopbackListener | undefined = undefined
    listener = await listenLoopback({
      port: MCP_OAUTH_CALLBACK_PORT,
      path: MCP_OAUTH_CALLBACK_PATH,
      respond: ({ params }) => {
        const state = params.get("state")
        const code = params.get("code")
        const oauthError = params.get("error")
        const pending = state === null ? undefined : this.pending.get(state)
        if (state === null || pending === undefined) {
          return page(400, "Connection failed", "The authorization request expired.")
        }
        clearTimeout(pending.timeout)
        this.pending.delete(state)
        if (oauthError !== null || code === null) {
          void pending.fail().catch(() => undefined)
          return page(400, "Connection failed", "The provider did not authorize Arden.")
        }
        void pending.complete(code).catch(() => undefined)
        return page(200, "Authorization received", "You can close this tab and return to Arden.")
      },
      onError: () => {
        if (this.listener === listener) this.listener = undefined
        const pending = [...this.pending.values()]
        this.pending.clear()
        for (const callback of pending) {
          clearTimeout(callback.timeout)
          void callback.fail().catch(() => undefined)
        }
      }
    })
    this.listener = listener
  }

  register(
    state: string,
    name: string,
    complete: (code: string) => Promise<void>,
    fail: () => Promise<void>
  ): void {
    const existing = this.pending.get(state)
    if (existing !== undefined) clearTimeout(existing.timeout)
    const timeout = setTimeout(() => {
      this.pending.delete(state)
      void fail().catch(() => undefined)
    }, CALLBACK_TIMEOUT_MS)
    this.pending.set(state, { name, complete, fail, timeout })
  }

  cancel(name: string): void {
    for (const [state, pending] of this.pending) {
      if (pending.name !== name) continue
      clearTimeout(pending.timeout)
      this.pending.delete(state)
    }
  }

  async close(): Promise<void> {
    await this.startPromise?.catch(() => undefined)
    for (const pending of this.pending.values()) clearTimeout(pending.timeout)
    this.pending.clear()
    const listener = this.listener
    this.listener = undefined
    await listener?.close()
  }
}
