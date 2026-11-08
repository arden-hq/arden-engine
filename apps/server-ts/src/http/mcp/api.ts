import {
  GitHubConnectionStateSchema,
  GitHubConnectRequestSchema,
  GitHubReadOnlyRequestSchema,
  McpCreateServerRequestSchema,
  McpOAuthStartResponseSchema,
  McpOfferDeclineReceiptSchema,
  McpOfferListSchema,
  McpOfferDeclineRequestSchema,
  McpPresetIdSchema,
  McpPresetInstallResponseSchema,
  McpPresetListResponseSchema,
  McpRemoveReceiptSchema,
  McpServerListResponseSchema,
  McpServerNameSchema,
  McpServerSchema,
  McpSetEnabledRequestSchema,
  McpUpdateServerRequestSchema
} from "@arden-hq/protocol/effect/mcp"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreInvalid, StoreConflict } from "../errors.js"

export class McpUnavailable extends Schema.Error<McpUnavailable>("McpUnavailable")(
  { detail: Schema.String },
  { httpApiStatus: 503 }
) {}

export class McpRejected extends Schema.Error<McpRejected>("McpRejected")(
  { detail: Schema.String },
  { httpApiStatus: 422 }
) {}

const mcpMutationErrors = [
  HttpApiError.NotFoundNoContent,
  StoreConflict,
  StoreInvalid,
  McpRejected,
  McpUnavailable,
  HttpApiError.InternalServerErrorNoContent
] as const

export class McpApi extends HttpApiGroup.make("mcp", { topLevel: true }).add(
  HttpApiEndpoint.get("listPresets", "/mcp/presets", {
    success: McpPresetListResponseSchema
  }),
  HttpApiEndpoint.post("installPreset", "/mcp/presets/:presetId/install", {
    params: { presetId: McpPresetIdSchema },
    success: McpPresetInstallResponseSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.get("list", "/mcp/servers", {
    success: McpServerListResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("create", "/mcp/servers", {
    payload: McpCreateServerRequestSchema,
    success: McpServerSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.put("update", "/mcp/servers/:name", {
    params: { name: McpServerNameSchema },
    payload: McpUpdateServerRequestSchema,
    success: McpServerSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.put("setEnabled", "/mcp/servers/:name/enabled", {
    params: { name: McpServerNameSchema },
    payload: McpSetEnabledRequestSchema,
    success: McpServerSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.post("reconnect", "/mcp/servers/:name/reconnect", {
    params: { name: McpServerNameSchema },
    success: McpServerSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.post("startOAuth", "/mcp/servers/:name/oauth", {
    params: { name: McpServerNameSchema },
    success: McpOAuthStartResponseSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.delete("remove", "/mcp/servers/:name", {
    params: { name: McpServerNameSchema },
    success: McpRemoveReceiptSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.post("declineOffer", "/mcp/offers/decline", {
    payload: McpOfferDeclineRequestSchema,
    success: McpOfferDeclineReceiptSchema,
    error: [
      HttpApiError.ForbiddenNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("listOffers", "/mcp/offers/:sessionId", {
    params: { sessionId: Schema.NonEmptyString },
    success: McpOfferListSchema,
    error: [HttpApiError.ForbiddenNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("githubState", "/mcp/github", {
    success: GitHubConnectionStateSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.post("githubConnect", "/mcp/github/connect", {
    payload: GitHubConnectRequestSchema,
    success: GitHubConnectionStateSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.put("githubReadOnly", "/mcp/github/read-only", {
    payload: GitHubReadOnlyRequestSchema,
    success: GitHubConnectionStateSchema,
    error: mcpMutationErrors
  }),
  HttpApiEndpoint.delete("githubDisconnect", "/mcp/github", {
    success: GitHubConnectionStateSchema,
    error: mcpMutationErrors
  })
) {}
