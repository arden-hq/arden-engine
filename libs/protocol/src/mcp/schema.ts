import { publicWebUrl, serverUrlIssue, type ServerUrlIssue } from "@arden-hq/std/url"
import { Effect, Schema } from "effect"
import { MCP_CONNECTION_STATUSES } from "./status.js"
import type {
  GitHubConnectionState,
  McpOAuthStartResponse,
  McpPresetInstallResponse,
  McpPresetListResponse,
  McpServer,
  McpServerListResponse,
  McpRemoveReceipt
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
const collectionPath = "/mcp/servers"

export const McpServerNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/))

const McpRemoteToolNameSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const McpPresetIdSchema = Schema.Literals([
  "github",
  "linear",
  "notion",
  "slack",
  "vercel"
] as const)

const McpPresetTitleSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

const McpPresetDescriptionSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_000)
)

const McpOAuthScopeSchema = Schema.String.check(
  Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]+$/u),
  Schema.isMaxLength(512)
)

const McpQualifiedToolNameSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))

const McpSecretNameSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/))

const McpSecretValueSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))

const McpSecretRecordSchema = Schema.Record(McpSecretNameSchema, McpSecretValueSchema)

export const McpSecretPatchSchema = Schema.Struct({
  set: McpSecretRecordSchema,
  retain: Schema.Array(McpSecretNameSchema)
}).check(
  Schema.makeFilter((patch) => {
    const retain = new Set(patch.retain)
    if (retain.size !== patch.retain.length) {
      return { path: ["retain"], issue: "contains duplicate names" }
    }
    const overlap = Object.keys(patch.set).find((name) => retain.has(name))
    return overlap === undefined ? undefined : { path: ["retain"], issue: `also sets ${overlap}` }
  })
)

const McpCommandSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))

const McpArgumentSchema = Schema.String.check(Schema.isMaxLength(8_192))

/** A local server's working folder: an absolute path. */
const McpFolderSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^\//)
)

const MCP_URL_ISSUE: Record<ServerUrlIssue, string> = {
  invalid: "must be an absolute HTTP URL",
  credentials: "must not contain embedded credentials",
  fragment: "must not contain a fragment",
  insecure: "must use HTTPS unless it targets loopback"
}

const McpUrlSchema = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => {
    const issue = serverUrlIssue(value)
    return issue === undefined ? undefined : MCP_URL_ISSUE[issue]
  })
)

/** A page the person opens to set a server up: a web page over HTTPS. */
const McpSetupUrlSchema = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => {
    const page = publicWebUrl(value)
    if (page.kind === "refused" && page.issue === "invalid") return "must be an absolute HTTPS URL"
    return page.kind === "ok" && page.url.protocol === "https:"
      ? undefined
      : "must be a public HTTPS URL"
  })
)

const McpAuthSchema = Schema.Literals(["none", "oauth", "headers"] as const)

const SortedUniqueScopesSchema = Schema.Array(McpOAuthScopeSchema).check(
  Schema.isMaxLength(128),
  Schema.makeFilter((scopes) => {
    const expected = [...new Set(scopes)].sort()
    return scopes.every((scope, index) => scope === expected[index])
      ? undefined
      : "must contain sorted unique scopes"
  })
)

export const McpPresetServerSchema = Schema.Struct({
  name: McpServerNameSchema,
  title: McpPresetTitleSchema,
  url: McpUrlSchema
})

export const McpPresetSchema = Schema.Struct({
  id: McpPresetIdSchema,
  title: McpPresetTitleSchema,
  description: McpPresetDescriptionSchema,
  setup_url: McpSetupUrlSchema,
  servers: Schema.Array(McpPresetServerSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.makeFilter((servers) =>
      new Set(servers.map((server) => server.name)).size === servers.length
        ? undefined
        : "contains duplicate server names"
    )
  ),
  auth: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("oauth"),
      client_type: Schema.Literals(["confidential", "dynamic"] as const),
      scopes: SortedUniqueScopesSchema
    }),
    Schema.Struct({ type: Schema.Literal("token") })
  ])
})

export const McpPresetListResponseSchema = Schema.Struct({
  presets: Schema.Array(McpPresetSchema).check(
    Schema.makeFilter((presets) => {
      const expected = [...presets].sort((left, right) => left.id.localeCompare(right.id))
      return presets.every((preset, index) => preset.id === expected[index]?.id) &&
        new Set(presets.map((preset) => preset.id)).size === presets.length
        ? undefined
        : "must contain sorted unique presets"
    })
  )
})

export const McpStdioTransportInputSchema = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: McpCommandSchema,
  args: Schema.Array(McpArgumentSchema).check(Schema.isMaxLength(128)),
  environment: McpSecretPatchSchema,
  /** Omitted keeps the stored folder; null is the person's home folder. */
  cwd: Schema.optionalKey(Schema.NullOr(McpFolderSchema))
})

export const McpHttpTransportInputSchema = Schema.Struct({
  type: Schema.Literal("http"),
  url: McpUrlSchema,
  auth: McpAuthSchema,
  headers: McpSecretPatchSchema
}).check(
  Schema.makeFilter((transport) =>
    transport.auth === "headers" ||
    (Object.keys(transport.headers.set).length === 0 && transport.headers.retain.length === 0)
      ? undefined
      : { path: ["headers"], issue: "requires header authentication" }
  )
)

export const McpTransportInputSchema = Schema.Union([
  McpStdioTransportInputSchema,
  McpHttpTransportInputSchema
])

export const McpCreateServerRequestSchema = Schema.Struct({
  name: McpServerNameSchema,
  transport: McpTransportInputSchema
})

export const McpUpdateServerRequestSchema = Schema.Struct({
  transport: McpTransportInputSchema
})

export const McpSetEnabledRequestSchema = Schema.Struct({ enabled: Schema.Boolean })

/** "Not now" on one connection card: the chat that showed it, and the call that offered it. */
export const McpOfferDeclineRequestSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  tool_call_id: Schema.NonEmptyString
})

/** Every connection card offered in a chat; `outcome` is null while one is open. */
export const McpOfferListSchema = Schema.Struct({
  offers: Schema.Array(
    Schema.Struct({
      tool_call_id: Schema.NonEmptyString,
      outcome: Schema.NullOr(Schema.Literals(["connected", "declined", "expired"] as const)),
      offered_at: Schema.NonEmptyString
    })
  )
})

export const McpOfferDeclineReceiptSchema = Schema.Struct({
  outcome: Schema.Literals(["declined", "already_answered"] as const)
})

const McpConnectionStatusSchema = Schema.Literals(MCP_CONNECTION_STATUSES)

const SortedUniqueNamesSchema = Schema.Array(McpSecretNameSchema).check(
  Schema.makeFilter((names) => {
    const expected = [...new Set(names)].sort()
    return names.every((name, index) => name === expected[index])
      ? undefined
      : "must contain sorted unique names"
  })
)

export const McpStdioTransportSchema = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: McpCommandSchema,
  args: Schema.Array(McpArgumentSchema).check(Schema.isMaxLength(128)),
  environment_keys: SortedUniqueNamesSchema,
  cwd: Schema.NullOr(McpFolderSchema)
})

export const McpHttpTransportSchema = Schema.Struct({
  type: Schema.Literal("http"),
  url: McpUrlSchema,
  auth: McpAuthSchema,
  header_keys: SortedUniqueNamesSchema
})

export const McpTransportSchema = Schema.Union([McpStdioTransportSchema, McpHttpTransportSchema])

export const McpToolSchema = Schema.Struct({
  name: McpRemoteToolNameSchema,
  full_name: McpQualifiedToolNameSchema,
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  description: Schema.String.check(Schema.isMaxLength(32_768))
})

export const McpEventSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  description: Schema.String.check(Schema.isMaxLength(32_768)),
  delivery: Schema.Array(Schema.Literals(["poll", "push", "webhook"] as const)),
  input_schema: Schema.Record(Schema.String, Schema.Unknown)
})

export const McpServerSchema = Schema.Struct({
  name: McpServerNameSchema,
  preset_id: Schema.NullOr(McpPresetIdSchema),
  enabled: Schema.Boolean,
  status: McpConnectionStatusSchema,
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000))),
  diagnostics: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_192))),
  account_identity: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
  ),
  transport: McpTransportSchema,
  tools: Schema.Array(McpToolSchema).check(
    Schema.makeFilter((tools) => {
      const remoteNames = new Set(tools.map((tool) => tool.name))
      const fullNames = new Set(tools.map((tool) => tool.full_name))
      return remoteNames.size === tools.length && fullNames.size === tools.length
        ? undefined
        : "contains duplicate tool names"
    })
  ),
  events: Schema.Array(McpEventSchema)
})

export const McpServerListResponseSchema = Schema.Struct({
  servers: Schema.Array(McpServerSchema)
}).check(
  Schema.makeFilter((response) => {
    const expected = [...response.servers].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
    return response.servers.every((server, index) => server.name === expected[index]?.name) &&
      new Set(response.servers.map((server) => server.name)).size === response.servers.length
      ? undefined
      : { path: ["servers"], issue: "must be sorted with unique names" }
  })
)

export const McpPresetInstallResponseSchema = Schema.Struct({
  preset_id: McpPresetIdSchema,
  servers: Schema.Array(McpServerSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((servers) =>
      servers.every((server) => server.preset_id !== null)
        ? undefined
        : { path: ["servers"], issue: "must contain preset-owned servers" }
    )
  )
}).check(
  Schema.makeFilter((response) => {
    const expected = [...response.servers].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
    const exactPreset = response.servers.every((server) => server.preset_id === response.preset_id)
    const sortedUnique =
      response.servers.every((server, index) => server.name === expected[index]?.name) &&
      new Set(response.servers.map((server) => server.name)).size === response.servers.length
    return exactPreset && sortedUnique
      ? undefined
      : { path: ["servers"], issue: "must match the preset and contain sorted unique names" }
  })
)

export const McpOAuthStartResponseSchema = Schema.Struct({
  name: McpServerNameSchema,
  authorization_url: Schema.NullOr(McpUrlSchema),
  status: Schema.Literals(["connected", "pending"] as const)
})

export const McpRemoveReceiptSchema: Schema.Codec<McpRemoveReceipt> = Schema.Struct({
  status: Schema.Literal("removed"),
  name: McpServerNameSchema
})

const mapTool = (tool: typeof McpToolSchema.Type) => ({
  name: tool.name,
  fullName: tool.full_name,
  title: tool.title,
  description: tool.description
})

const mapPreset = (preset: typeof McpPresetSchema.Type) => ({
  id: preset.id,
  title: preset.title,
  description: preset.description,
  setupUrl: preset.setup_url,
  servers: preset.servers,
  auth:
    preset.auth.type === "token"
      ? { type: preset.auth.type }
      : {
          type: preset.auth.type,
          clientType: preset.auth.client_type,
          scopes: preset.auth.scopes
        }
})

const mapTransport = (transport: typeof McpTransportSchema.Type) =>
  transport.type === "stdio"
    ? {
        type: transport.type,
        command: transport.command,
        args: transport.args,
        environmentKeys: transport.environment_keys,
        cwd: transport.cwd
      }
    : {
        type: transport.type,
        url: transport.url,
        auth: transport.auth,
        headerKeys: transport.header_keys
      }

export const mapServer = (server: typeof McpServerSchema.Type): McpServer => ({
  name: server.name,
  presetId: server.preset_id,
  enabled: server.enabled,
  status: server.status,
  detail: server.detail,
  diagnostics: server.diagnostics,
  accountIdentity: server.account_identity,
  transport: mapTransport(server.transport),
  tools: server.tools.map(mapTool),
  events: server.events.map((event) => ({
    name: event.name,
    description: event.description,
    delivery: event.delivery,
    inputSchema: event.input_schema
  }))
})

export const mapPresetInstall = (
  response: typeof McpPresetInstallResponseSchema.Type
): McpPresetInstallResponse => ({
  presetId: response.preset_id,
  servers: response.servers.map(mapServer)
})

export const toMcpPresetList = (
  response: typeof McpPresetListResponseSchema.Type
): McpPresetListResponse => ({ presets: response.presets.map(mapPreset) })

export const toMcpServerList = (
  response: typeof McpServerListResponseSchema.Type
): McpServerListResponse => ({ servers: response.servers.map(mapServer) })

export const toMcpOAuthStart = (
  response: typeof McpOAuthStartResponseSchema.Type
): McpOAuthStartResponse => ({
  name: response.name,
  authorizationUrl: response.authorization_url,
  status: response.status
})

export const encodeMcpCreateServerRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(McpCreateServerRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpUpdateServerRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(McpUpdateServerRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpSetEnabledRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(McpSetEnabledRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpOfferDeclineRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(McpOfferDeclineRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpServerPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(McpServerNameSchema)(value).pipe(
    Effect.map((name) => `${collectionPath}/${encodeURIComponent(name)}`)
  )

export const encodeMcpPresetPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(McpPresetIdSchema)(value).pipe(
    Effect.map((presetId) => `/mcp/presets/${encodeURIComponent(presetId)}`)
  )

export const GitHubConnectionStateSchema = Schema.Struct({
  connection: Schema.NullOr(
    Schema.Struct({ read_only: Schema.Boolean, source: Schema.Literals(["token", "app"]) })
  )
})

/** A pasted token is one opaque word: GitHub's `ghp_`/`github_pat_` tokens
 *  and classic 40-hex ones all fit. */
const GitHubTokenSchema = Schema.String.check(
  Schema.isMinLength(20),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9_]+$/)
)

export const GitHubConnectRequestSchema = Schema.Struct({ token: GitHubTokenSchema })

export const GitHubReadOnlyRequestSchema = Schema.Struct({ read_only: Schema.Boolean })

export const toGitHubConnectionState = (
  response: typeof GitHubConnectionStateSchema.Type
): GitHubConnectionState => ({
  connection:
    response.connection === null
      ? null
      : { readOnly: response.connection.read_only, source: response.connection.source }
})

export const encodeGitHubConnectRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(GitHubConnectRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeGitHubReadOnlyRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(GitHubReadOnlyRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
