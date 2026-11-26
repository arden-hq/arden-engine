import { publicServer } from "./public-server.js"
import { after } from "@arden-hq/std/timer"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { type McpServer as PublicMcpServer } from "@arden-hq/protocol/mcp"
import { Effect } from "effect"

import { errorMessage } from "@arden-hq/std/errors"
import type { McpStore, McpStoredServer } from "../persistence/mcp/store.js"
import { sameMcpTools } from "./call-binding.js"
import { listMcpTools, type McpToolBinding } from "./catalog.js"
import { closeMcpClient, connectMcpClient, makeMcpClient, type ClosableClient } from "./client.js"
import { mcpError, type McpOperation } from "./errors.js"
import { McpChannel } from "./channel.js"
import { classifyMcpStartFailure, mcpFailureSentence } from "./failure.js"
import { canReconnect, mcpConnectBudgetMs, nextConnectRetryMs, reconnectDelayMs } from "./retry.js"
import { type McpTokenAuth } from "./github-connection.js"
import { mcpToolApproval, usesPresetToken } from "./presets.js"
import type { KeyedSerialQueue } from "./serial.js"
import type { makeMcpServerSecrets } from "./server-secrets.js"
import {
  assertMcpSignInSetUp,
  makeMcpTransport,
  mcpOAuthVaultTarget,
  mcpServiceTitle,
  McpStdioTransport
} from "./transport.js"
import {
  clearMcpOAuthCredentials,
  readMcpOAuthAccountIdentity,
  type McpOAuthVault
} from "./vault.js"
import { type McpRuntime } from "./runtime-types.js"
import {
  type ConnectOptions,
  type McpLiveEvents,
  type RuntimeEntry,
  type RuntimeStatus,
  classifyConnectFailure,
  httpStatusCode,
  notifyIgnoringListenerFailures,
  publicFailure,
  shouldRetry,
  storeFailure,
  cancelRetry,
  readEvents,
  toolNameCollision,
  isConnected,
  isReconnecting,
  usesOAuth
} from "./runtime-state.js"
import { assertUnclaimed, boundToolNamesOf } from "./runtime-state.js"

export const makeMcpRuntime = ({
  store,
  vault,
  credentials,
  operations,
  secrets,
  tokenAuth
}: {
  readonly store: McpStore["Service"]
  readonly vault: McpOAuthVault | undefined
  readonly credentials: KeyedSerialQueue
  readonly operations: KeyedSerialQueue
  readonly secrets: ReturnType<typeof makeMcpServerSecrets>
  readonly tokenAuth: McpTokenAuth
}): McpRuntime => {
  const runtimes = new Map<string, RuntimeEntry>()
  const connectedListeners = new Set<(config: McpStoredServer) => void>()
  const changeListeners = new Set<(name: string) => void>()
  const changed = (name: string): void => {
    notifyIgnoringListenerFailures(changeListeners, name)
  }
  const accountIdentities = new Map<string, string | null>()
  const startedConfigs = new WeakSet<McpStoredServer>()
  let nextGeneration = 1
  let shuttingDown = false

  const snapshotOne = (entry: RuntimeEntry): PublicMcpServer =>
    publicServer(entry, accountIdentities.get(entry.config.name) ?? null)

  const requireRuntime = (name: string, operation: McpOperation): RuntimeEntry => {
    const entry = runtimes.get(name)
    if (entry === undefined) throw mcpError(operation, "not_found", "MCP server was not found")
    return entry
  }

  const lastConnectedTools = new Map<string, ReadonlyArray<McpToolBinding>>()

  const publish = (entry: RuntimeEntry): RuntimeEntry => {
    const previous = runtimes.get(entry.config.name)
    runtimes.set(entry.config.name, entry)
    if (
      previous === undefined ||
      JSON.stringify(snapshotOne(previous)) !== JSON.stringify(snapshotOne(entry))
    ) {
      changed(entry.config.name)
    }
    if (isConnected(entry)) lastConnectedTools.set(entry.config.name, entry.tools)
    else if (!isReconnecting(entry)) lastConnectedTools.delete(entry.config.name)
    return entry
  }

  const boundToolNames = (): Map<string, string> => boundToolNamesOf(runtimes)
  const assertToolNamesUnclaimed = (
    serverName: string,
    tools: ReadonlyArray<McpToolBinding>
  ): void => assertUnclaimed(runtimes, serverName, tools)

  const interruptConnection = (name: string): void => {
    const current = runtimes.get(name)
    if (current === undefined) return
    cancelRetry(current)
    void closeMcpClient(current)
  }

  const replaceCredentialIdentity = async (
    config: McpStoredServer,
    operation: McpOperation
  ): Promise<void> => {
    const credentialKey = mcpOAuthVaultTarget(config).credentialKey
    const affected = [...runtimes.values()].filter((entry) => {
      if (!usesOAuth(entry.config)) return false
      return mcpOAuthVaultTarget(entry.config).credentialKey === credentialKey
    })
    await Effect.runPromise(
      store
        .invalidatePermissions(affected.map((entry) => entry.config.name))
        .pipe(Effect.mapError((cause) => storeFailure(operation, cause)))
    )
  }

  const clearOAuth = async (config: McpStoredServer): Promise<void> => {
    if (!usesOAuth(config)) return
    await credentials.run(mcpOAuthVaultTarget(config).credentialKey, () =>
      clearMcpOAuthCredentials(vault, mcpOAuthVaultTarget(config))
    )
    accountIdentities.set(config.name, null)
  }

  const refreshAccountIdentity = async (config: McpStoredServer): Promise<void> => {
    if (usesPresetToken(config)) return
    if (config.transport.type !== "http" || config.transport.auth !== "oauth") {
      accountIdentities.set(config.name, null)
      return
    }
    const identity = await readMcpOAuthAccountIdentity(vault, mcpOAuthVaultTarget(config)).catch(
      () => null
    )
    accountIdentities.set(config.name, identity)
  }

  const reconnectPresetSiblings = (source: McpStoredServer): void => {
    if (source.presetId === null) return
    for (const entry of runtimes.values()) {
      if (
        entry.config.name === source.name ||
        !entry.config.enabled ||
        entry.config.presetId !== source.presetId
      )
        continue
      interruptConnection(entry.config.name)
      void connect(entry.config).catch(() => undefined)
    }
  }

  const reconnectAfterLoss = (active: RuntimeEntry): void => {
    const attempt = active.retryAttempt + 1
    if (!canReconnect(attempt)) {
      const local = active.transport instanceof McpStdioTransport ? active.transport : undefined
      const diagnostics = local?.stderrTail()
      publish({
        config: active.config,
        generation: active.generation,
        status: "failed",
        detail:
          local === undefined
            ? publicFailure("failed")
            : mcpFailureSentence({ reason: "crashed", stderr: diagnostics }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        tools: [],
        events: [],
        retryAttempt: attempt
      })
      return
    }
    const retryTimer = after(reconnectDelayMs(attempt), () => {
      void connect(active.config, { status: "reconnecting", retryAttempt: attempt }).catch(
        () => undefined
      )
    })
    publish({
      config: active.config,
      generation: active.generation,
      status: "reconnecting",
      detail: null,
      tools: [],
      events: [],
      retryAttempt: attempt,
      retryTimer
    })
  }

  const connectNow = async (
    config: McpStoredServer,
    { status = "starting", retryAttempt = 0, refreshPath = false }: ConnectOptions = {}
  ): Promise<RuntimeEntry> => {
    if (shuttingDown) return requireRuntime(config.name, "reconnect")
    const previous = runtimes.get(config.name)
    previous?.retryTimer?.cancel()
    const generation = nextGeneration++
    publish({
      config,
      generation,
      status: config.enabled ? status : "disabled",
      detail: null,
      tools: [],
      events: [],
      retryAttempt
    })
    await closeMcpClient(previous)
    if (!config.enabled) return requireRuntime(config.name, "reconnect")

    let authorizationUrl: URL | undefined
    let closable: ClosableClient = {}
    try {
      await assertMcpSignInSetUp(config, vault)
      const tokenIdentity = usesPresetToken(config) ? await tokenAuth.identify() : undefined
      const transportSecrets = await secrets.read(config)
      const channel = new McpChannel(config.transport.type)
      const transport = await makeMcpTransport(config, {
        ...(vault === undefined ? {} : { vault }),
        credentials,
        onAuthorization: (url) => {
          authorizationUrl = url
        },
        beforeIdentityReplacement: () => replaceCredentialIdentity(config, "oauth"),
        transportSecrets,
        refreshPath,
        presetHeaders: tokenAuth.headers,
        wrapFetch: (fetch) => channel.wrapFetch(fetch)
      })
      channel.attach(transport)
      const client = makeMcpClient()
      closable = { client, transport }
      publish({
        config,
        generation,
        status,
        detail: null,
        client,
        transport,
        channel,
        tools: [],
        events: [],
        retryAttempt
      })
      await connectMcpClient(
        client,
        channel,
        mcpConnectBudgetMs({
          transport: config.transport.type,
          firstStart: !startedConfigs.has(config)
        })
      )
      startedConfigs.add(config)
      const tools = await listMcpTools(client, {
        serverName: config.name,
        serverTitle: mcpServiceTitle(config),
        approval: (remoteName) => mcpToolApproval(config, remoteName)
      })
      const events = await readEvents(config, channel)
      if (tokenIdentity === undefined) await refreshAccountIdentity(config)
      else accountIdentities.set(config.name, tokenIdentity)
      const current = runtimes.get(config.name)
      if (current?.generation !== generation) {
        await closeMcpClient({ client, transport })
        if (current === undefined) {
          throw mcpError("reconnect", "not_found", "MCP server was removed while connecting")
        }
        return current
      }
      assertToolNamesUnclaimed(config.name, tools)
      const connected = publish({
        config,
        generation,
        status: "connected",
        detail: null,
        client,
        transport,
        channel,
        tools,
        events,
        retryAttempt: 0
      })
      notifyIgnoringListenerFailures(connectedListeners, config)
      let refreshRequest = 0
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        const request = ++refreshRequest
        void listMcpTools(client, {
          serverName: config.name,
          serverTitle: mcpServiceTitle(config),
          approval: (remoteName) => mcpToolApproval(config, remoteName)
        })
          .then((refreshed) => {
            const latest = runtimes.get(config.name)
            if (request === refreshRequest && latest?.client === client) {
              assertToolNamesUnclaimed(config.name, refreshed)
              if (sameMcpTools(latest.tools, refreshed)) return
              publish({ ...latest, tools: refreshed })
            }
          })
          .catch((cause: unknown) => {
            const latest = runtimes.get(config.name)
            if (request !== refreshRequest || latest?.client !== client) return
            void closeMcpClient(latest).then(() => {
              const active = runtimes.get(config.name)
              if (active?.generation !== latest.generation) return
              const failure = toolNameCollision(cause)
              if (failure !== undefined && !shouldRetry(failure)) {
                publish({
                  config: active.config,
                  generation: active.generation,
                  status: "failed",
                  detail: failure.detail,
                  tools: [],
                  events: [],
                  retryAttempt: active.retryAttempt
                })
                return
              }
              reconnectAfterLoss(active)
            })
          })
      })
      client.onclose = () => {
        const active = runtimes.get(config.name)
        if (active?.client !== client) return
        reconnectAfterLoss(active)
      }
      return connected
    } catch (cause) {
      const stdio = closable.transport instanceof McpStdioTransport ? closable.transport : undefined
      const local =
        config.transport.type === "stdio"
          ? classifyMcpStartFailure({
              cause,
              executable: stdio?.executable,
              exited: stdio?.exited ?? false,
              stderr: stdio?.stderrTail()
            })
          : undefined
      const diagnostics = stdio?.diagnostics(cause)
      const failureDiagnostics = diagnostics === undefined ? {} : { diagnostics }
      await closeMcpClient(closable)
      const current = runtimes.get(config.name)
      if (current?.generation !== generation) {
        if (current === undefined) {
          throw mcpError("reconnect", "not_found", "MCP server was removed while connecting")
        }
        return current
      }
      const failure = classifyConnectFailure(cause, config, local)
      if (!shouldRetry(failure)) {
        if (failure.kind === "credential_unavailable") accountIdentities.set(config.name, null)
        return publish({
          config,
          generation,
          status: "failed",
          detail: failure.detail,
          ...(failure.kind === "unrunnable_program" ? failureDiagnostics : {}),
          tools: [],
          events: [],
          retryAttempt
        })
      }
      const needsAuth =
        cause instanceof UnauthorizedError ||
        authorizationUrl !== undefined ||
        httpStatusCode(cause) === 401
      const retryMs = nextConnectRetryMs({
        phase: status,
        attempt: retryAttempt,
        reason: local?.reason,
        needsAuth
      })
      if (retryMs !== undefined) {
        const nextAttempt = retryAttempt + 1
        const retryTimer = after(retryMs, () => {
          void connect(config, { status, retryAttempt: nextAttempt }).catch(() => undefined)
        })
        return publish({
          config,
          generation,
          status,
          detail: null,
          ...failureDiagnostics,
          tools: [],
          events: [],
          retryAttempt: nextAttempt,
          retryTimer
        })
      }
      if (!needsAuth && local === undefined) {
        Effect.runSync(
          Effect.logWarning("MCP server did not connect").pipe(
            Effect.annotateLogs({
              server: config.name,
              cause: errorMessage(cause)
            })
          )
        )
      }
      return publish({
        config,
        generation,
        status: needsAuth ? "needs_auth" : "failed",
        detail:
          local === undefined
            ? publicFailure(needsAuth ? "needs_auth" : "failed")
            : mcpFailureSentence(local),
        ...failureDiagnostics,
        tools: [],
        events: [],
        retryAttempt
      })
    }
  }

  const connect = (config: McpStoredServer, options: ConnectOptions = {}): Promise<RuntimeEntry> =>
    operations.run(config.name, () => {
      const current = runtimes.get(config.name)
      if (current === undefined) {
        throw mcpError("reconnect", "not_found", "MCP server was removed before connecting")
      }
      if (current.config !== config || !config.enabled) return Promise.resolve(current)
      return connectNow(config, options)
    })

  const reset = (config: McpStoredServer, status: RuntimeStatus): RuntimeEntry =>
    publish({
      config,
      generation: nextGeneration++,
      status,
      detail: publicFailure(status),
      tools: [],
      events: [],
      retryAttempt: 0
    })

  return {
    get: (name: string): RuntimeEntry | undefined => runtimes.get(name),
    liveEvents: (name: string): McpLiveEvents | undefined => {
      const entry = runtimes.get(name)
      if (entry?.status !== "connected" || entry.client === undefined) return undefined
      if (entry.channel === undefined) return undefined
      const channel = entry.channel
      return { client: entry.client, channel, events: entry.events }
    },
    has: (name: string): boolean => runtimes.has(name),
    names: (): ReadonlyArray<string> => [...runtimes.keys()],
    requireRuntime,
    boundToolNames,
    snapshotOne,
    snapshot: (): ReadonlyArray<PublicMcpServer> =>
      [...runtimes.values()]
        .sort((left, right) => left.config.name.localeCompare(right.config.name))
        .map(snapshotOne),
    bindings: (): ReadonlyArray<McpToolBinding> =>
      [...runtimes.values()]
        .filter((entry) => entry.status === "connected")
        .flatMap((entry) => entry.tools),
    runBindings: (): ReadonlyArray<McpToolBinding> =>
      [...runtimes.values()].flatMap((entry) => {
        if (entry.status === "connected") return entry.tools
        if (entry.status === "reconnecting") return lastConnectedTools.get(entry.config.name) ?? []
        return []
      }),
    reset,
    onConnected: (listener: (config: McpStoredServer) => void): (() => void) => {
      connectedListeners.add(listener)
      return () => connectedListeners.delete(listener)
    },
    onChanged: (listener: (name: string) => void): (() => void) => {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    start: (config: McpStoredServer): RuntimeEntry => {
      const entry = reset(config, config.enabled ? "starting" : "disabled")
      if (config.enabled) void connect(config).catch(() => undefined)
      return entry
    },
    forget: (name: string): void => {
      runtimes.delete(name)
      lastConnectedTools.delete(name)
      accountIdentities.delete(name)
      changed(name)
    },
    interruptConnection,
    replaceCredentialIdentity,
    clearOAuth,
    refreshAccountIdentity,
    connectNow,
    connect,
    reconnectPresetSiblings,
    shutdown: async (): Promise<void> => {
      shuttingDown = true
      await Promise.all(
        [...runtimes.values()].map((entry) => {
          entry.retryTimer?.cancel()
          return closeMcpClient(entry)
        })
      )
    }
  }
}
