import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { McpPresetId } from "@arden-hq/protocol/mcp"

import {
  McpStoredTransportSchema,
  McpStore,
  McpStoreError,
  type McpStoredServer,
  type McpStoreOperation
} from "../mcp/store.js"
import type { PersistenceDeps } from "./deps.js"
import { iso } from "../../runtime/clock.js"

const strict = { onExcessProperty: "error" } as const
const TransportJsonSchema = Schema.fromJsonString(McpStoredTransportSchema)

interface ServerRow {
  readonly name: string
  readonly preset_id: McpStoredServer["presetId"]
  readonly enabled: number
  readonly transport_json: string
}

const error = (
  operation: McpStoreOperation,
  reason: McpStoreError["reason"],
  message: string,
  cause?: unknown
) =>
  new McpStoreError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const storage = (operation: McpStoreOperation, message: string) => (cause: unknown) =>
  cause instanceof McpStoreError ? cause : error(operation, "storage", message, cause)

const decodeServer = Effect.fn("SqliteMcpStore.decodeServer")(function* (
  row: ServerRow,
  operation: McpStoreOperation
) {
  const transport = yield* Schema.decodeUnknownEffect(TransportJsonSchema)(
    row.transport_json,
    strict
  ).pipe(Effect.mapError(storage(operation, `Stored MCP server ${row.name} is corrupt`)))
  if (row.enabled !== 0 && row.enabled !== 1) {
    return yield* error(operation, "storage", `Stored MCP server ${row.name} has invalid state`)
  }
  return {
    name: row.name,
    presetId: row.preset_id,
    enabled: row.enabled === 1,
    transport
  } satisfies McpStoredServer
})

const encodeTransport = (transport: McpStoredServer["transport"]) =>
  Schema.encodeEffect(TransportJsonSchema)(transport).pipe(
    Effect.mapError((cause) => error("save", "invalid", "MCP transport cannot be encoded", cause))
  )

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index])

const sameTransport = (
  left: McpStoredServer["transport"],
  right: McpStoredServer["transport"]
): boolean => {
  if (left.type !== right.type) return false
  if (left.type === "stdio" && right.type === "stdio") {
    return (
      left.command === right.command &&
      left.cwd === right.cwd &&
      left.args.length === right.args.length &&
      left.args.every((argument, index) => argument === right.args[index]) &&
      sameKeys(left.environmentKeys, right.environmentKeys)
    )
  }
  return (
    left.type === "http" &&
    right.type === "http" &&
    left.url === right.url &&
    left.auth === right.auth &&
    sameKeys(left.headerKeys, right.headerKeys)
  )
}

const samePresetServer = (left: McpStoredServer, right: McpStoredServer): boolean =>
  left.name === right.name &&
  left.presetId === right.presetId &&
  sameTransport(left.transport, right.transport)

const nextRevision = (sql: SqlClient.SqlClient, now: string) => sql`strftime('%Y-%m-%dT%H:%M:%fZ',
  max(julianday(${now}), julianday(updated_at) + 1.0 / 86400000))`

const clockNow = Effect.map(Clock.currentTimeMillis, iso)

const dropConnectionGrants = (sql: SqlClient.SqlClient, names: ReadonlyArray<string>) =>
  sql`DELETE FROM permission_rules
    WHERE ${sql.in("server_name", names)} AND list_kind != 'global' AND decision = 'allow'`

export const makeMcpStore = ({ writer }: Pick<PersistenceDeps, "writer">): McpStore["Service"] => {
  const sql = writer.sql
  const list = Effect.fn("SqliteMcpStore.list")(function* () {
    const rows = yield* sql<ServerRow>`
      SELECT name, preset_id, enabled, transport_json FROM mcp_servers ORDER BY name
    `.pipe(Effect.mapError(storage("list", "Could not read MCP servers")))
    return yield* Effect.forEach(rows, (row) => decodeServer(row, "list"))
  })

  const get = Effect.fn("SqliteMcpStore.get")(function* (name: string) {
    const rows = yield* sql<ServerRow>`
      SELECT name, preset_id, enabled, transport_json FROM mcp_servers WHERE name = ${name}
    `.pipe(Effect.mapError(storage("get", "Could not read MCP server")))
    const row = rows[0]
    return row === undefined ? null : yield* decodeServer(row, "get")
  })

  const create = Effect.fn("SqliteMcpStore.create")(function* (server: McpStoredServer) {
    const transport = yield* encodeTransport(server.transport).pipe(
      Effect.mapError((cause) => error("create", cause.reason, cause.message, cause))
    )
    const updatedAt = yield* clockNow
    const rows = yield* writer
      .transact(
        sql<{ readonly name: string }>`
      INSERT INTO mcp_servers (name, preset_id, enabled, transport_json, updated_at)
      VALUES (
        ${server.name},
        ${server.presetId},
        ${server.enabled ? 1 : 0},
        ${transport},
        ${updatedAt}
      )
      ON CONFLICT(name) DO NOTHING
      RETURNING name
    `
      )
      .pipe(Effect.mapError(storage("create", "Could not create MCP server")))
    if (rows.length !== 1) {
      return yield* error("create", "conflict", "MCP server already exists")
    }
    return server
  })

  const installPreset = Effect.fn("SqliteMcpStore.installPreset")(function* (
    presetId: McpPresetId,
    servers: ReadonlyArray<McpStoredServer>
  ) {
    if (servers.length === 0 || servers.some((server) => server.presetId !== presetId)) {
      return yield* error("install_preset", "invalid", "MCP preset servers are invalid")
    }
    const names = new Set(servers.map((server) => server.name))
    if (names.size !== servers.length) {
      return yield* error("install_preset", "invalid", "MCP preset server names are not unique")
    }
    const updatedAt = yield* clockNow
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<ServerRow>`
        SELECT name, preset_id, enabled, transport_json FROM mcp_servers
      `.pipe(Effect.mapError(storage("install_preset", "Could not inspect MCP preset servers")))
          const unexpected = rows.find((row) => row.preset_id === presetId && !names.has(row.name))
          if (unexpected !== undefined) {
            return yield* error(
              "install_preset",
              "conflict",
              `MCP preset owns unexpected server ${unexpected.name}`
            )
          }

          const installed: McpStoredServer[] = []
          for (const server of servers) {
            const row = rows.find((candidate) => candidate.name === server.name)
            if (row !== undefined) {
              const existing = yield* decodeServer(row, "install_preset")
              if (!samePresetServer(existing, server)) {
                return yield* error(
                  "install_preset",
                  "conflict",
                  `MCP server ${server.name} conflicts with the trusted preset`
                )
              }
              installed.push(existing)
              continue
            }
            const transport = yield* encodeTransport(server.transport).pipe(
              Effect.mapError((cause) =>
                error("install_preset", cause.reason, cause.message, cause)
              )
            )
            yield* sql`
          INSERT INTO mcp_servers (name, preset_id, enabled, transport_json, updated_at)
          VALUES (
            ${server.name},
            ${server.presetId},
            ${server.enabled ? 1 : 0},
            ${transport},
            ${updatedAt}
          )
        `.pipe(Effect.mapError(storage("install_preset", "Could not install MCP preset server")))
            installed.push(server)
          }
          return installed.sort((left, right) => left.name.localeCompare(right.name))
        })
      )
      .pipe(Effect.mapError(storage("install_preset", "Could not install MCP preset")))
  })

  const save = Effect.fn("SqliteMcpStore.save")(function* (server: McpStoredServer) {
    const transport = yield* encodeTransport(server.transport)
    const now = yield* clockNow
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly name: string }>`
        UPDATE mcp_servers SET preset_id = ${server.presetId}, enabled = ${server.enabled ? 1 : 0},
          transport_json = ${transport}, updated_at = ${nextRevision(sql, now)}
        WHERE name = ${server.name} RETURNING name
      `.pipe(Effect.mapError(storage("save", "Could not save MCP server")))
          if (rows.length !== 1) return yield* error("save", "not_found", "MCP server was removed")
          yield* dropConnectionGrants(sql, [server.name]).pipe(
            Effect.mapError(storage("save", "Could not clear changed MCP permissions"))
          )
          return server
        })
      )
      .pipe(Effect.mapError(storage("save", "Could not complete MCP server update")))
  })

  const invalidatePermissions = Effect.fn("SqliteMcpStore.invalidatePermissions")(function* (
    names: ReadonlyArray<string>
  ) {
    if (names.length === 0) return
    const now = yield* clockNow
    yield* writer
      .transact(
        Effect.gen(function* () {
          yield* sql`UPDATE mcp_servers SET updated_at = ${nextRevision(sql, now)} WHERE ${sql.in("name", names)}`
          yield* dropConnectionGrants(sql, names)
        })
      )
      .pipe(
        Effect.mapError(
          storage("invalidate_permissions", "Could not invalidate MCP account permissions")
        )
      )
  })

  const forgetGlobalRules = Effect.fn("SqliteMcpStore.forgetGlobalRules")(function* (name: string) {
    yield* writer
      .transact(
        sql`DELETE FROM permission_rules WHERE server_name = ${name} AND list_kind = 'global'`
      )
      .pipe(Effect.mapError(storage("forget_global_rules", "Could not clear the server's rules")))
  })

  const setEnabled = Effect.fn("SqliteMcpStore.setEnabled")(function* (
    name: string,
    enabled: boolean
  ) {
    const now = yield* clockNow
    yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly name: string }>`
        UPDATE mcp_servers SET enabled = ${enabled ? 1 : 0}, updated_at = ${nextRevision(sql, now)}
        WHERE name = ${name} RETURNING name
      `.pipe(Effect.mapError(storage("set_enabled", "Could not update MCP server state")))
          if (rows.length !== 1)
            return yield* error("set_enabled", "not_found", "MCP server was not found")
        })
      )
      .pipe(Effect.mapError(storage("set_enabled", "Could not complete MCP server state update")))
    const server = yield* get(name)
    if (server === null) return yield* error("set_enabled", "not_found", "MCP server was not found")
    return server
  })

  const remove = Effect.fn("SqliteMcpStore.remove")(function* (name: string) {
    yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly name: string }>`
        DELETE FROM mcp_servers WHERE name = ${name} RETURNING name
      `.pipe(Effect.mapError(storage("remove", "Could not remove MCP server")))
          if (rows.length !== 1)
            return yield* error("remove", "not_found", "MCP server was not found")
        })
      )
      .pipe(Effect.mapError(storage("remove", "Could not complete MCP server removal")))
  })

  return McpStore.of({
    list,
    get,
    create,
    installPreset,
    save,
    invalidatePermissions,
    forgetGlobalRules,
    setEnabled,
    remove
  })
}
