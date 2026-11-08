import { storeErrorFields } from "../errors.js"
import { Context, Effect, Schema } from "effect"
import type { McpPresetId } from "@arden-hq/protocol/mcp"

export type McpStoreOperation =
  | "list"
  | "get"
  | "create"
  | "install_preset"
  | "save"
  | "invalidate_permissions"
  | "forget_global_rules"
  | "set_enabled"
  | "remove"

const McpStoredSecretNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
)

const McpStoredSecretKeysSchema = Schema.Array(McpStoredSecretNameSchema).check(
  Schema.makeFilter((keys) => {
    const expected = [...new Set(keys)].sort()
    return keys.every((key, index) => key === expected[index])
      ? undefined
      : "must contain sorted unique names"
  })
)

export const McpStoredTransportSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    args: Schema.Array(Schema.String.check(Schema.isMaxLength(8_192))).check(
      Schema.isMaxLength(128)
    ),
    environmentKeys: McpStoredSecretKeysSchema,
    cwd: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)))
  }),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    auth: Schema.Literals(["none", "oauth", "headers"] as const),
    headerKeys: McpStoredSecretKeysSchema
  }).check(
    Schema.makeFilter((transport) =>
      transport.auth === "headers" || transport.headerKeys.length === 0
        ? undefined
        : { path: ["headerKeys"], issue: "requires header authentication" }
    )
  )
])

export type McpStoredTransport = typeof McpStoredTransportSchema.Type

export interface McpStoredServer {
  readonly name: string
  readonly presetId: McpPresetId | null
  readonly enabled: boolean
  readonly transport: McpStoredTransport
}

export class McpStoreError extends Schema.TaggedError<McpStoreError>()("McpStoreError", {
  ...storeErrorFields({
    operations: [
      "list",
      "get",
      "create",
      "install_preset",
      "save",
      "invalidate_permissions",
      "forget_global_rules",
      "set_enabled",
      "remove"
    ],
    reasons: ["conflict", "not_found", "invalid", "storage"]
  })
}) {}

export class McpStore extends Context.Service<
  McpStore,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<McpStoredServer>, McpStoreError>
    readonly get: (name: string) => Effect.Effect<McpStoredServer | null, McpStoreError>
    readonly create: (server: McpStoredServer) => Effect.Effect<McpStoredServer, McpStoreError>
    readonly installPreset: (
      presetId: McpPresetId,
      servers: ReadonlyArray<McpStoredServer>
    ) => Effect.Effect<ReadonlyArray<McpStoredServer>, McpStoreError>
    readonly save: (server: McpStoredServer) => Effect.Effect<McpStoredServer, McpStoreError>
    readonly forgetGlobalRules: (name: string) => Effect.Effect<void, McpStoreError>
    readonly invalidatePermissions: (
      names: ReadonlyArray<string>
    ) => Effect.Effect<void, McpStoreError>
    readonly setEnabled: (
      name: string,
      enabled: boolean
    ) => Effect.Effect<McpStoredServer, McpStoreError>
    readonly remove: (name: string) => Effect.Effect<void, McpStoreError>
  }
>()("@arden-hq/server/persistence/mcp/McpStore") {}
