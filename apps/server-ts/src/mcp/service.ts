import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type {
  GitHubConnectionState,
  GitHubConnectRequest,
  McpPresetId,
  McpServer as PublicMcpServer
} from "@arden-hq/protocol/mcp"
import type {
  McpCreateServerRequestSchema,
  McpUpdateServerRequestSchema
} from "@arden-hq/protocol/effect/mcp"
import { Context, Effect, Layer, Scope } from "effect"

import { VaultError } from "../credentials/vault.js"
import { McpStore, type McpStoreError, type McpStoredServer } from "../persistence/mcp/store.js"
import { makeMcpAuthorization, type McpAuthorizationStart } from "./authorization.js"
import type { McpToolBinding } from "./catalog.js"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { resolveMcpCall } from "./call-binding.js"
import { retriesMcpCall } from "./call-retry.js"
import { callMcpTool, closeMcpClient, type McpToolCall } from "./client.js"
import { McpConnectionError, mcpError, type McpOperation } from "./errors.js"
import { makeMcpEventSubscriptions, McpEvents } from "./events/subscriptions.js"
import { McpOAuthCallbacks } from "./oauth.js"
import { makeGitHubOAuth } from "./github-oauth.js"
import { GitHubTokenRejected, makeGitHubConnection } from "./github-connection.js"
import { MCP_PRESETS, mcpPresetTransportAuth } from "./presets.js"
import { cancelRetry, makeMcpRuntime, storeFailure } from "./runtime.js"
import { KeyedSerialQueue } from "./serial.js"
import { makeMcpServerSecrets } from "./server-secrets.js"
import { mcpServiceTitle, mcpSignInNotSetUpDetail } from "./transport.js"
import { MCP_CREDENTIALS_UNREADABLE, McpSignInNotSetUp, type McpOAuthVault } from "./vault.js"

type CreateInput = typeof McpCreateServerRequestSchema.Type
type UpdateInput = typeof McpUpdateServerRequestSchema.Type

const runServerOperations = <A>(
  queue: KeyedSerialQueue,
  names: ReadonlyArray<string>,
  operation: () => Promise<A>
): Promise<A> => {
  const keys = [...new Set(names)].sort()
  const run = (index: number): Promise<A> => {
    const key = keys[index]
    return key === undefined ? operation() : queue.run(key, () => run(index + 1))
  }
  return run(0)
}

export class McpConnections extends Context.Service<
  McpConnections,
  {
    readonly snapshot: () => Effect.Effect<ReadonlyArray<PublicMcpServer>>
    readonly installPreset: (
      presetId: McpPresetId
    ) => Effect.Effect<ReadonlyArray<PublicMcpServer>, McpConnectionError>
    readonly create: (input: CreateInput) => Effect.Effect<PublicMcpServer, McpConnectionError>
    readonly update: (
      name: string,
      input: UpdateInput
    ) => Effect.Effect<PublicMcpServer, McpConnectionError>
    readonly setEnabled: (
      name: string,
      enabled: boolean
    ) => Effect.Effect<PublicMcpServer, McpConnectionError>
    readonly reconnect: (name: string) => Effect.Effect<PublicMcpServer, McpConnectionError>
    readonly remove: (name: string) => Effect.Effect<void, McpConnectionError>
    readonly startOAuth: (name: string) => Effect.Effect<McpAuthorizationStart, McpConnectionError>
    readonly bindings: () => ReadonlyArray<McpToolBinding>
    readonly runBindings: () => ReadonlyArray<McpToolBinding>
    readonly onConnected: (
      listener: (server: {
        readonly presetId: string | undefined
        readonly url: string | undefined
      }) => void
    ) => () => void
    readonly onChanged: (listener: (name: string) => void) => () => void
    readonly call: (input: McpToolCall) => Promise<CallToolResult>
    readonly github: {
      readonly state: () => Effect.Effect<GitHubConnectionState, McpConnectionError>
      readonly connect: (
        request: GitHubConnectRequest
      ) => Effect.Effect<GitHubConnectionState, McpConnectionError>
      readonly setReadOnly: (
        readOnly: boolean
      ) => Effect.Effect<GitHubConnectionState, McpConnectionError>
      readonly disconnect: () => Effect.Effect<GitHubConnectionState, McpConnectionError>
      readonly token: () => Effect.Effect<string | undefined, McpConnectionError>
    }
  }
>()("@arden-hq/server/mcp/McpConnections") {}

export const mcpConnectionsLayer = (
  vault?: McpOAuthVault
): Layer.Layer<McpConnections | McpEvents, McpStoreError, McpStore> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const store = yield* McpStore
      const scope = yield* Scope.Scope
      const configs = yield* store.list()
      const operations = new KeyedSerialQueue()
      const credentials = new KeyedSerialQueue()
      const secrets = makeMcpServerSecrets(vault)
      const callbacks = new McpOAuthCallbacks()
      const githubOAuth = makeGitHubOAuth({ vault, credentials, operations, callbacks })
      const github = makeGitHubConnection({ vault, oauth: githubOAuth })
      const runtime = makeMcpRuntime({
        store,
        vault,
        credentials,
        operations,
        secrets,
        tokenAuth: github.auth
      })
      const authorization = makeMcpAuthorization({
        runtime,
        vault,
        credentials,
        operations,
        callbacks
      })

      const purgeApprovalOverrides = (name: string, operation: McpOperation): Promise<void> =>
        Effect.runPromise(
          store
            .forgetGlobalRules(name)
            .pipe(Effect.mapError((cause) => storeFailure(operation, cause)))
        )

      yield* Effect.forkScoped(
        Effect.promise(() => Promise.all(configs.map(runtime.refreshAccountIdentity)))
      )
      for (const config of configs) runtime.start(config)
      const events = yield* makeMcpEventSubscriptions(runtime.liveEvents)

      yield* Scope.addFinalizer(
        scope,
        Effect.promise(async () => {
          const stopped = runtime.shutdown()
          githubOAuth.cancel()
          await authorization.close()
          await stopped
        })
      )

      const snapshot = () => Effect.sync(runtime.snapshot)

      const installPreset = (presetId: McpPresetId) =>
        Effect.tryPromise({
          try: () => {
            const definitions = MCP_PRESETS[presetId].servers.map(
              (server) =>
                ({
                  name: server.name,
                  presetId,
                  enabled: true,
                  transport: {
                    type: "http" as const,
                    url: server.url,
                    auth: mcpPresetTransportAuth(presetId),
                    headerKeys: []
                  }
                }) satisfies McpStoredServer
            )
            return runServerOperations(
              operations,
              definitions.map((server) => server.name),
              async () => {
                const installed = await Effect.runPromise(
                  store
                    .installPreset(presetId, definitions)
                    .pipe(Effect.mapError((cause) => storeFailure("install_preset", cause)))
                )
                for (const config of installed) {
                  if (!runtime.has(config.name)) runtime.start(config)
                }
                return installed.map((config) =>
                  runtime.snapshotOne(runtime.requireRuntime(config.name, "install_preset"))
                )
              }
            )
          },
          catch: (cause) =>
            cause instanceof McpConnectionError
              ? cause
              : mcpError("install_preset", "storage", "MCP preset could not be installed", cause)
        })

      const create = (input: CreateInput) =>
        Effect.tryPromise({
          try: () =>
            operations.run(input.name, async () => {
              if (runtime.has(input.name))
                throw mcpError("create", "conflict", "MCP server already exists")
              await purgeApprovalOverrides(input.name, "create")
              const prepared = await secrets.next(input.name, input.transport, undefined, "create")
              const config: McpStoredServer = {
                name: input.name,
                presetId: null,
                enabled: true,
                transport: prepared.transport
              }
              await secrets.save(config, prepared.secrets)
              try {
                await Effect.runPromise(
                  store
                    .create(config)
                    .pipe(Effect.mapError((cause) => storeFailure("create", cause)))
                )
              } catch (cause) {
                await secrets.clear(config).catch(() => undefined)
                throw cause
              }
              return runtime.snapshotOne(runtime.start(config))
            }),
          catch: (cause) => vaultAwareFailure("create", "MCP server could not be created", cause)
        })

      const update = (name: string, input: UpdateInput) =>
        Effect.tryPromise({
          try: () => {
            return operations.run(name, async () => {
              const current = runtime.requireRuntime(name, "update")
              if (current.config.presetId !== null) {
                throw mcpError(
                  "update",
                  "invalid",
                  "Trusted MCP preset transports cannot be changed"
                )
              }
              if (name === "github") githubOAuth.cancel()
              runtime.interruptConnection(name)
              const prepared = await secrets.next(name, input.transport, current.config, "update")
              const transport = prepared.transport
              const config = { ...current.config, transport }
              const changesOAuthIdentity =
                current.config.transport.type === "http" &&
                (transport.type !== "http" ||
                  current.config.transport.url !== transport.url ||
                  current.config.transport.auth !== transport.auth)
              if (changesOAuthIdentity) await runtime.clearOAuth(current.config)
              await purgeApprovalOverrides(name, "update")
              await secrets.save(config, prepared.secrets)
              try {
                await Effect.runPromise(
                  store.save(config).pipe(Effect.mapError((cause) => storeFailure("update", cause)))
                )
              } catch (cause) {
                await secrets.save(current.config, prepared.previousSecrets).catch(() => undefined)
                throw cause
              }
              await authorization.cancel(name)
              cancelRetry(current)
              await closeMcpClient(current)
              return runtime.snapshotOne(runtime.start(config))
            })
          },
          catch: (cause) => vaultAwareFailure("update", "MCP server could not be updated", cause)
        })

      const setEnabled = (name: string, enabled: boolean) =>
        Effect.tryPromise({
          try: () => {
            if (name === "github") githubOAuth.cancel()
            runtime.interruptConnection(name)
            return operations.run(name, async () => {
              const current = runtime.requireRuntime(name, "set_enabled")
              const config = await Effect.runPromise(
                store
                  .setEnabled(name, enabled)
                  .pipe(Effect.mapError((cause) => storeFailure("set_enabled", cause)))
              )
              await authorization.cancel(name)
              cancelRetry(current)
              const next = runtime.reset(config, enabled ? "starting" : "disabled")
              await closeMcpClient(current)
              if (enabled) void runtime.connect(config).catch(() => undefined)
              return runtime.snapshotOne(next)
            })
          },
          catch: (cause) =>
            cause instanceof McpConnectionError
              ? cause
              : mcpError("set_enabled", "storage", "MCP server state could not be changed", cause)
        })

      const reconnect = (name: string) =>
        Effect.tryPromise({
          try: () => {
            if (name === "github") githubOAuth.cancel()
            runtime.interruptConnection(name)
            return operations.run(name, async () => {
              const current = runtime.requireRuntime(name, "reconnect")
              if (!current.config.enabled) {
                throw mcpError("reconnect", "invalid", "Disabled MCP servers cannot reconnect")
              }
              await authorization.cancel(name)
              try {
                return runtime.snapshotOne(
                  await runtime.connectNow(current.config, { refreshPath: true })
                )
              } catch (cause) {
                if (cause instanceof McpConnectionError) throw cause
                throw mcpError("reconnect", "unavailable", notAnswering(current.config), cause)
              }
            })
          },
          catch: (cause) =>
            cause instanceof McpConnectionError
              ? cause
              : mcpError("reconnect", "unavailable", "Couldn’t reconnect. Try again.", cause)
        })

      const remove = (name: string) =>
        Effect.tryPromise({
          try: () => {
            if (name === "github") githubOAuth.cancel()
            runtime.interruptConnection(name)
            return operations.run(name, async () => {
              const current = runtime.requireRuntime(name, "remove")
              if (current.config.presetId === "github") await github.forget()
              await runtime.clearOAuth(current.config)
              await secrets.clear(current.config)
              await purgeApprovalOverrides(name, "remove")
              await Effect.runPromise(
                store.remove(name).pipe(Effect.mapError((cause) => storeFailure("remove", cause)))
              )
              runtime.forget(name)
              cancelRetry(current)
              await authorization.cancel(name)
              await closeMcpClient(current)
            })
          },
          catch: (cause) =>
            cause instanceof McpConnectionError
              ? cause
              : mcpError("remove", "storage", "MCP server could not be removed", cause)
        })

      const startOAuth = (name: string) =>
        Effect.tryPromise({
          try: () => {
            if (name === "github") githubOAuth.cancel()
            runtime.interruptConnection(name)
            return operations.run(name, async () => {
              const current = runtime.requireRuntime(name, "oauth")
              const transport = current.config.transport
              if (current.config.presetId === "github" && current.config.enabled) {
                try {
                  const url = await githubOAuth.start({
                    beforeCommit: async () => {
                      await purgeApprovalOverrides(name, "oauth")
                    },
                    onConnected: async () => {
                      await github.useApp()
                      await reconnectGitHub()
                    },
                    onFailure: async () => {
                      await runtime.connectNow(current.config)
                    }
                  })
                  cancelRetry(current)
                  runtime.reset(current.config, "needs_auth")
                  await closeMcpClient(current)
                  return { name, authorization_url: url, status: "pending" as const }
                } catch (cause) {
                  if (cause instanceof McpSignInNotSetUp)
                    throw mcpError(
                      "oauth",
                      "not_set_up",
                      "GitHub needs app credentials. Open Manage to set up your app.",
                      cause
                    )
                  if (cause instanceof VaultError)
                    throw mcpError("oauth", "unavailable", MCP_CREDENTIALS_UNREADABLE, cause)
                  throw mcpError(
                    "oauth",
                    "unavailable",
                    "GitHub sign-in couldn’t start. Try again.",
                    cause
                  )
                }
              }
              if (
                !current.config.enabled ||
                transport.type !== "http" ||
                transport.auth !== "oauth"
              ) {
                throw mcpError("oauth", "invalid", "MCP server does not use OAuth")
              }
              await purgeApprovalOverrides(name, "oauth")
              try {
                return await authorization.start(current, transport.url)
              } catch (cause) {
                if (cause instanceof McpConnectionError) throw cause
                if (cause instanceof McpSignInNotSetUp) {
                  throw mcpError(
                    "oauth",
                    "not_set_up",
                    mcpSignInNotSetUpDetail(current.config),
                    cause
                  )
                }
                if (cause instanceof VaultError) {
                  throw mcpError("oauth", "unavailable", MCP_CREDENTIALS_UNREADABLE, cause)
                }
                throw mcpError("oauth", "unavailable", notAnswering(current.config), cause)
              }
            })
          },
          catch: (cause) =>
            cause instanceof McpConnectionError
              ? cause
              : mcpError("oauth", "unavailable", "Sign-in couldn’t start. Try again.", cause)
        })

      const call = async (input: McpToolCall): Promise<CallToolResult> => {
        const { client, binding } = resolveMcpCall(runtime.get(input.serverName), input)
        try {
          return await callMcpTool({ client, binding, input })
        } catch (cause) {
          const transport = runtime.get(input.serverName)?.config.transport.type
          if (
            transport === undefined ||
            input.signal.aborted ||
            !retriesMcpCall({ cause, transport, readOnly: binding.readOnly })
          ) {
            throw cause
          }
          await reconnectAfterFailure(input.serverName, client)
          const retry = resolveMcpCall(runtime.get(input.serverName), input)
          return callMcpTool({
            client: retry.client,
            binding: retry.binding,
            input: { ...input, onSent: () => undefined }
          })
        }
      }

      const reconnectAfterFailure = (name: string, failed: Client): Promise<void> =>
        operations.run(name, async () => {
          const current = runtime.get(name)
          if (current === undefined || !current.config.enabled) return
          if (current.status === "connected" && current.client !== failed) return
          await runtime.connectNow(current.config, { status: "reconnecting" })
        })

      const githubServers = () =>
        runtime.names().flatMap((name) => {
          const entry = runtime.get(name)
          return entry?.config.presetId === "github" ? [entry.config] : []
        })

      const reconnectGitHub = async (): Promise<void> => {
        const servers = githubServers()
        await Effect.runPromise(
          store
            .invalidatePermissions(servers.map((server) => server.name))
            .pipe(Effect.mapError((cause) => storeFailure("github", cause)))
        )
        for (const server of servers) {
          runtime.interruptConnection(server.name)
          const current = runtime.get(server.name)
          if (current?.config.enabled === true) await runtime.connectNow(current.config)
        }
      }

      const githubState = () =>
        Effect.tryPromise({
          try: () => github.state(),
          catch: (cause) => githubFailure("GitHub connection could not be read", cause)
        })

      const githubOperation = (fallback: string, operation: () => Promise<void>) =>
        Effect.tryPromise({
          try: operation,
          catch: (cause) => githubFailure(fallback, cause)
        }).pipe(Effect.andThen(githubState))

      const githubConnections = {
        state: githubState,
        connect: (request: GitHubConnectRequest) =>
          githubOperation("GitHub couldn’t be connected", async () => {
            githubOAuth.cancel()
            await operations.run("github", async () => {
              await github.connect(request)
              await purgeApprovalOverrides("github", "github")
            })
            await Effect.runPromise(installPreset("github"))
            await operations.run("github", reconnectGitHub)
          }),
        setReadOnly: (readOnly: boolean) =>
          githubOperation("GitHub’s read-only setting couldn’t be changed", async () => {
            await operations.run("github", async () => {
              await github.setReadOnly(readOnly)
              await reconnectGitHub()
            })
          }),
        disconnect: () =>
          githubOperation("GitHub couldn’t be disconnected", async () => {
            githubOAuth.cancel()
            for (const server of githubServers()) await Effect.runPromise(remove(server.name))
            await operations.run("github", () => github.forget())
          }),
        token: () =>
          Effect.tryPromise({
            try: () => github.token(),
            catch: (cause) => githubFailure("GitHub token could not be read", cause)
          })
      }

      return Context.make(
        McpConnections,
        McpConnections.of({
          github: githubConnections,
          snapshot,
          installPreset,
          create,
          update,
          setEnabled,
          reconnect,
          remove,
          startOAuth,
          bindings: runtime.bindings,
          runBindings: runtime.runBindings,
          onConnected: (listener) =>
            runtime.onConnected((config) =>
              listener({
                presetId: config.presetId ?? undefined,
                url: config.transport.type === "http" ? config.transport.url : undefined
              })
            ),
          onChanged: runtime.onChanged,
          call
        })
      ).pipe(Context.add(McpEvents, events))
    })
  )

const notAnswering = (config: McpStoredServer): string =>
  `${mcpServiceTitle(config)} isn’t answering right now. Try again in a few minutes.`

const githubFailure = (fallback: string, cause: unknown): McpConnectionError => {
  if (cause instanceof McpConnectionError) return cause
  if (cause instanceof GitHubTokenRejected) {
    return mcpError("github", "rejected", cause.detail, cause)
  }
  if (cause instanceof VaultError) {
    return mcpError(
      "github",
      "unavailable",
      "Arden’s secure storage isn’t available right now. Try again in a moment.",
      cause
    )
  }
  return mcpError("github", "unavailable", `${fallback}. Try again in a moment.`, cause)
}

const vaultAwareFailure = (
  operation: "create" | "update",
  fallback: string,
  cause: unknown
): McpConnectionError => {
  if (cause instanceof McpConnectionError) return cause
  if (cause instanceof VaultError) {
    return cause.reason === "invalid"
      ? mcpError(operation, "invalid", cause.message, cause)
      : mcpError(
          operation,
          "unavailable",
          "Arden’s secure storage isn’t available right now. Try again in a moment.",
          cause
        )
  }
  return mcpError(operation, "invalid", fallback, cause)
}
