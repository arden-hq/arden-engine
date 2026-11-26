import {
  PUBLIC_WEB_URL,
  WEB_PROTOCOL,
  WEB_URL_ISSUE,
  publicWebUrl,
  serverUrlIssue,
  type ServerUrlIssue
} from "@arden-hq/std/url"
import { strict } from "../common/boundary.js"
import { Effect, Schema } from "effect"
import { MCP_CONNECTION_STATUS } from "./status.js"
import {
  GITHUB_CONNECTION,
  GITHUB_CONNECTION_SOURCE,
  MCP_ACCOUNT,
  MCP_AUTH,
  MCP_DIAGNOSTICS,
  MCP_EVENT_DELIVERY,
  MCP_FOLDER,
  MCP_OAUTH_CLIENT,
  MCP_OAUTH_START,
  MCP_OFFER_DECLINE,
  MCP_OFFER_OUTCOME,
  MCP_PRESET_AUTH,
  MCP_PRESET_ID,
  MCP_SERVER_DETAIL,
  MCP_SERVER_PRESET,
  MCP_TOOL_TITLE,
  MCP_TRANSPORT,
  type GitHubConnectionState,
  type McpOAuthStartResponse,
  type McpPresetInstallResponse,
  type McpPresetListResponse,
  type McpServer,
  type McpServerListResponse,
  type McpRemoveReceipt,
  type McpTool
} from "./contracts.js"

const collectionPath = "/mcp/servers"

export const McpServerNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/))

const McpRemoteToolNameSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const McpPresetIdSchema = Schema.Literals(Object.values(MCP_PRESET_ID))

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

const McpSetupUrlSchema = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => {
    const page = publicWebUrl(value)
    if (page.kind === PUBLIC_WEB_URL.refused && page.issue === WEB_URL_ISSUE.invalid)
      return "must be an absolute HTTPS URL"
    return page.kind === PUBLIC_WEB_URL.ok && page.url.protocol === WEB_PROTOCOL.https
      ? undefined
      : "must be a public HTTPS URL"
  })
)

const McpAuthSchema = Schema.Literals(Object.values(MCP_AUTH))

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
      type: Schema.Literal(MCP_PRESET_AUTH.oauth),
      client_type: Schema.Literals(Object.values(MCP_OAUTH_CLIENT)),
      scopes: SortedUniqueScopesSchema
    }),
    Schema.Struct({ type: Schema.Literal(MCP_PRESET_AUTH.token) })
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
  type: Schema.Literal(MCP_TRANSPORT.stdio),
  command: McpCommandSchema,
  args: Schema.Array(McpArgumentSchema).check(Schema.isMaxLength(128)),
  environment: McpSecretPatchSchema,
  cwd: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MCP_FOLDER.keep) }),
    Schema.Struct({ kind: Schema.Literal(MCP_FOLDER.home) }),
    Schema.Struct({ kind: Schema.Literal(MCP_FOLDER.folder), path: McpFolderSchema })
  ])
})

export const McpHttpTransportInputSchema = Schema.Struct({
  type: Schema.Literal(MCP_TRANSPORT.http),
  url: McpUrlSchema,
  auth: McpAuthSchema,
  headers: McpSecretPatchSchema
}).check(
  Schema.makeFilter((transport) =>
    transport.auth === MCP_AUTH.headers ||
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

export const McpOfferDeclineRequestSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  tool_call_id: Schema.NonEmptyString
})

export const McpOfferListSchema = Schema.Struct({
  offers: Schema.Array(
    Schema.Struct({
      tool_call_id: Schema.NonEmptyString,
      outcome: Schema.Literals(Object.values(MCP_OFFER_OUTCOME)),
      offered_at: Schema.NonEmptyString
    })
  )
})

export const McpOfferDeclineReceiptSchema = Schema.Struct({
  outcome: Schema.Literals(Object.values(MCP_OFFER_DECLINE))
})

const McpConnectionStatusSchema = Schema.Literals(Object.values(MCP_CONNECTION_STATUS))

const SortedUniqueNamesSchema = Schema.Array(McpSecretNameSchema).check(
  Schema.makeFilter((names) => {
    const expected = [...new Set(names)].sort()
    return names.every((name, index) => name === expected[index])
      ? undefined
      : "must contain sorted unique names"
  })
)

export const McpStdioTransportSchema = Schema.Struct({
  type: Schema.Literal(MCP_TRANSPORT.stdio),
  command: McpCommandSchema,
  args: Schema.Array(McpArgumentSchema).check(Schema.isMaxLength(128)),
  environment_keys: SortedUniqueNamesSchema,
  cwd: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MCP_FOLDER.home) }),
    Schema.Struct({ kind: Schema.Literal(MCP_FOLDER.folder), path: McpFolderSchema })
  ])
})

export const McpHttpTransportSchema = Schema.Struct({
  type: Schema.Literal(MCP_TRANSPORT.http),
  url: McpUrlSchema,
  auth: McpAuthSchema,
  header_keys: SortedUniqueNamesSchema
})

export const McpTransportSchema = Schema.Union([McpStdioTransportSchema, McpHttpTransportSchema])

export const McpToolSchema = Schema.Struct({
  name: McpRemoteToolNameSchema,
  full_name: McpQualifiedToolNameSchema,
  title: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MCP_TOOL_TITLE.untitled) }),
    Schema.Struct({
      kind: Schema.Literal(MCP_TOOL_TITLE.titled),
      text: Schema.String.check(Schema.isMaxLength(512))
    })
  ]),
  description: Schema.String.check(Schema.isMaxLength(32_768))
})

export const McpEventSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  description: Schema.String.check(Schema.isMaxLength(32_768)),
  delivery: Schema.Array(Schema.Literals(Object.values(MCP_EVENT_DELIVERY))),
  input_schema: Schema.Record(Schema.String, Schema.Unknown)
})

export const McpServerSchema = Schema.Struct({
  name: McpServerNameSchema,
  preset: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MCP_SERVER_PRESET.custom) }),
    Schema.Struct({ kind: Schema.Literal(MCP_SERVER_PRESET.preset), id: McpPresetIdSchema })
  ]),
  enabled: Schema.Boolean,
  status: McpConnectionStatusSchema,
  detail: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MCP_SERVER_DETAIL.quiet) }),
    Schema.Struct({
      kind: Schema.Literal(MCP_SERVER_DETAIL.shown),
      text: Schema.String.check(Schema.isMaxLength(1_000))
    })
  ]),
  diagnostics: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MCP_DIAGNOSTICS.clean) }),
    Schema.Struct({
      kind: Schema.Literal(MCP_DIAGNOSTICS.captured),
      text: Schema.String.check(Schema.isMaxLength(8_192))
    })
  ]),
  account: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MCP_ACCOUNT.unknown) }),
    Schema.Struct({
      kind: Schema.Literal(MCP_ACCOUNT.identified),
      identity: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
    })
  ]),
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
      servers.every((server) => server.preset.kind === MCP_SERVER_PRESET.preset)
        ? undefined
        : { path: ["servers"], issue: "must contain preset-owned servers" }
    )
  )
}).check(
  Schema.makeFilter((response) => {
    const expected = [...response.servers].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
    const exactPreset = response.servers.every(
      (server) =>
        server.preset.kind === MCP_SERVER_PRESET.preset && server.preset.id === response.preset_id
    )
    const sortedUnique =
      response.servers.every((server, index) => server.name === expected[index]?.name) &&
      new Set(response.servers.map((server) => server.name)).size === response.servers.length
    return exactPreset && sortedUnique
      ? undefined
      : { path: ["servers"], issue: "must match the preset and contain sorted unique names" }
  })
)

export const McpOAuthStartResponseSchema = Schema.Union([
  Schema.Struct({
    name: McpServerNameSchema,
    status: Schema.Literals([MCP_OAUTH_START.connected, MCP_OAUTH_START.authorized])
  }),
  Schema.Struct({
    name: McpServerNameSchema,
    status: Schema.Literal(MCP_OAUTH_START.pending),
    authorization_url: McpUrlSchema
  })
])

export const McpRemoveReceiptSchema: Schema.Codec<McpRemoveReceipt> = Schema.Struct({
  status: Schema.Literal("removed"),
  name: McpServerNameSchema
})

const mapTool = (tool: typeof McpToolSchema.Type): McpTool => ({
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
    preset.auth.type === MCP_PRESET_AUTH.token
      ? { type: preset.auth.type }
      : {
          type: preset.auth.type,
          clientType: preset.auth.client_type,
          scopes: preset.auth.scopes
        }
})

const mapTransport = (transport: typeof McpTransportSchema.Type) =>
  transport.type === MCP_TRANSPORT.stdio
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
  preset: server.preset,
  enabled: server.enabled,
  status: server.status,
  detail: server.detail,
  diagnostics: server.diagnostics,
  account: server.account,
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
): McpOAuthStartResponse =>
  response.status === MCP_OAUTH_START.pending
    ? { name: response.name, status: response.status, authorizationUrl: response.authorization_url }
    : { name: response.name, status: response.status }

export const encodeMcpCreateServerRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(McpCreateServerRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpUpdateServerRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(McpUpdateServerRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpSetEnabledRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(McpSetEnabledRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpOfferDeclineRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(McpOfferDeclineRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMcpServerPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(McpServerNameSchema)(value).pipe(
    Effect.map((name) => `${collectionPath}/${encodeURIComponent(name)}`)
  )

export const encodeMcpPresetPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(McpPresetIdSchema)(value).pipe(
    Effect.map((presetId) => `/mcp/presets/${encodeURIComponent(presetId)}`)
  )

export const GitHubConnectionStateSchema = Schema.Struct({
  connection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(GITHUB_CONNECTION.disconnected) }),
    Schema.Struct({
      kind: Schema.Literal(GITHUB_CONNECTION.connected),
      read_only: Schema.Boolean,
      source: Schema.Literals(Object.values(GITHUB_CONNECTION_SOURCE))
    })
  ])
})

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
    response.connection.kind === GITHUB_CONNECTION.connected
      ? {
          kind: response.connection.kind,
          readOnly: response.connection.read_only,
          source: response.connection.source
        }
      : response.connection
})

export const encodeGitHubConnectRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(GitHubConnectRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeGitHubReadOnlyRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(GitHubReadOnlyRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
