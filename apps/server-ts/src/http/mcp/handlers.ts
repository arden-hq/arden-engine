import type { GitHubConnectionState, McpServer } from "@arden-hq/protocol/mcp"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import type { McpConnectionError } from "../../mcp/errors.js"
import { McpConnections } from "../../mcp/service.js"
import { mcpPresetCatalog } from "../../mcp/presets.js"
import { errorMessage } from "@arden-hq/std/errors"
import { ArdenApi } from "../api.js"
import { CapabilityOfferStore } from "../../persistence/capability-offers/store.js"
import { LocalCaller } from "../middleware/local-only.js"
import { McpRejected, McpUnavailable } from "./api.js"
import { StoreInvalid, storeErrorToHttp } from "../errors.js"

const mapError = (error: McpConnectionError) => {
  if (error.reason === "auth_required") return new StoreInvalid({ detail: error.message })
  if (error.reason === "rejected") return new McpRejected({ detail: error.message })
  if (error.reason === "not_set_up" || error.reason === "unavailable")
    return new McpUnavailable({ detail: error.message })
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

const logFailure = (error: McpConnectionError) =>
  error.reason === "not_set_up" || error.reason === "unavailable" || error.reason === "storage"
    ? Effect.logWarning("MCP request failed").pipe(
        Effect.annotateLogs({
          operation: error.operation,
          reason: error.reason,
          message: error.message,
          cause: errorMessage(error.cause, "none")
        })
      )
    : Effect.void

const toHttp = <A>(effect: Effect.Effect<A, McpConnectionError>) =>
  effect.pipe(Effect.tapError(logFailure), Effect.mapError(mapError))

const transportResponse = (transport: McpServer["transport"]) =>
  transport.type === "stdio"
    ? {
        type: transport.type,
        command: transport.command,
        args: [...transport.args],
        environment_keys: [...transport.environmentKeys],
        cwd: transport.cwd
      }
    : {
        type: transport.type,
        url: transport.url,
        auth: transport.auth,
        header_keys: [...transport.headerKeys]
      }

const githubResponse = (state: GitHubConnectionState) => ({
  connection:
    state.connection === null
      ? null
      : { read_only: state.connection.readOnly, source: state.connection.source }
})

const serverResponse = (server: McpServer) => ({
  name: server.name,
  preset_id: server.presetId,
  enabled: server.enabled,
  status: server.status,
  detail: server.detail,
  diagnostics: server.diagnostics,
  account_identity: server.accountIdentity,
  transport: transportResponse(server.transport),
  tools: server.tools.map((tool) => ({
    name: tool.name,
    full_name: tool.fullName,
    title: tool.title,
    description: tool.description
  })),
  events: server.events.map((event) => ({
    name: event.name,
    description: event.description,
    delivery: [...event.delivery],
    input_schema: event.inputSchema
  }))
})

export const McpHandlers = HttpApiBuilder.group(
  ArdenApi,
  "mcp",
  Effect.fn("McpHandlers")(function* (handlers) {
    const connections = yield* McpConnections
    const offers = yield* CapabilityOfferStore
    return handlers
      .handle(
        "listOffers",
        Effect.fn("McpHandlers.listOffers")(function* ({ params }) {
          if ((yield* LocalCaller) !== "desktop") return yield* new HttpApiError.Forbidden({})
          const rows = yield* offers
            .list(params.sessionId)
            .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
          return {
            offers: rows.map((row) => ({
              tool_call_id: row.toolCallId,
              outcome: row.outcome,
              offered_at: row.offeredAt
            }))
          }
        })
      )
      .handle(
        "declineOffer",
        Effect.fn("McpHandlers.declineOffer")(function* ({ payload }) {
          if ((yield* LocalCaller) !== "desktop") return yield* new HttpApiError.Forbidden({})
          const result = yield* offers
            .decline({ sessionId: payload.session_id, toolCallId: payload.tool_call_id })
            .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
          if (result === "unknown") return yield* new HttpApiError.NotFound({})
          return { outcome: result }
        })
      )
      .handle("listPresets", () =>
        Effect.succeed({
          presets: mcpPresetCatalog().map((preset) => ({
            id: preset.id,
            title: preset.title,
            description: preset.description,
            setup_url: preset.setupUrl,
            servers: preset.servers,
            auth:
              preset.auth.type === "token"
                ? { type: preset.auth.type }
                : {
                    type: preset.auth.type,
                    client_type: preset.auth.clientType,
                    scopes: preset.auth.scopes
                  }
          }))
        })
      )
      .handle("list", () =>
        connections
          .snapshot()
          .pipe(Effect.map((servers) => ({ servers: servers.map(serverResponse) })))
      )
      .handle("installPreset", ({ params }) =>
        toHttp(connections.installPreset(params.presetId)).pipe(
          Effect.map((servers) => ({
            preset_id: params.presetId,
            servers: servers.map(serverResponse)
          }))
        )
      )
      .handle("create", ({ payload }) =>
        toHttp(connections.create(payload)).pipe(Effect.map(serverResponse))
      )
      .handle("update", ({ params, payload }) =>
        toHttp(connections.update(params.name, payload)).pipe(Effect.map(serverResponse))
      )
      .handle("setEnabled", ({ params, payload }) =>
        toHttp(connections.setEnabled(params.name, payload.enabled)).pipe(
          Effect.map(serverResponse)
        )
      )
      .handle("reconnect", ({ params }) =>
        toHttp(connections.reconnect(params.name)).pipe(Effect.map(serverResponse))
      )
      .handle("startOAuth", ({ params }) => toHttp(connections.startOAuth(params.name)))
      .handle("remove", ({ params }) =>
        toHttp(connections.remove(params.name)).pipe(
          Effect.as({ status: "removed" as const, name: params.name })
        )
      )
      .handle("githubState", () =>
        toHttp(connections.github.state()).pipe(Effect.map(githubResponse))
      )
      .handle("githubConnect", ({ payload }) =>
        toHttp(connections.github.connect(payload)).pipe(Effect.map(githubResponse))
      )
      .handle("githubReadOnly", ({ payload }) =>
        toHttp(connections.github.setReadOnly(payload.read_only)).pipe(Effect.map(githubResponse))
      )
      .handle("githubDisconnect", () =>
        toHttp(connections.github.disconnect()).pipe(Effect.map(githubResponse))
      )
  })
)
