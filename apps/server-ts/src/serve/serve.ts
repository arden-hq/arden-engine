import { LOCAL_CAPABILITY_HEADER, type ConfiguredServerReady } from "@arden-hq/protocol/daemon"
import { randomBytes } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { HostedServerOptions } from "../config/options.js"
import { ownerDataDirectory } from "../config/service.js"
import type { LocalAccess } from "../http/middleware/local-only.js"
import type { ModelHost } from "../models/host.js"
import { cliAccessPath, publishCliAccess, withdrawCliAccess } from "../runtime/cli-access.js"
import { applySettings, type AppliedSettings, type ServerRequest } from "./apply.js"
import { meteredProvider } from "./meter.js"
import { modelsFor } from "./models.js"
import { SettingsError, type Settings } from "./settings.js"

/** The start options a settings file stands for; the rest is applied after start. */
const serverOptionsFor = (
  settings: Settings
): { readonly databasePath: string } & Pick<
  HostedServerOptions,
  | "port"
  | "maxRunSteps"
  | "memory"
  | "sharedSkillRoots"
  | "commandSandbox"
  | "idleCompactionAfterMs"
  | "approvalMode"
  | "userFacing"
  | "workFolder"
> => ({
  port: settings.port ?? 0,
  databasePath: join(settings.dataDirectory, "arden.db"),
  ...(settings.maxSteps === undefined ? {} : { maxRunSteps: settings.maxSteps }),
  // A program drives a configured server, so nobody follows its chats unless the file says so.
  userFacing: settings.userFacing ?? false,
  ...(settings.workspace === undefined ? {} : { workFolder: settings.workspace }),
  ...(settings.memory === undefined ? {} : { memory: settings.memory }),
  ...(settings.approvalMode === undefined ? {} : { approvalMode: settings.approvalMode }),
  ...(settings.skillRoots === undefined ? {} : { sharedSkillRoots: settings.skillRoots }),
  ...(settings.commandSandbox === undefined ? {} : { commandSandbox: settings.commandSandbox }),
  ...(settings.idleCompactionAfterMs === undefined
    ? {}
    : { idleCompactionAfterMs: settings.idleCompactionAfterMs })
})

const USAGE_FILE = "usage.json"

/** What a configured start needs of the server it starts. */
export interface StartedServer {
  readonly url: URL
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly stop: () => Promise<void>
}

/** The server's own start, handed in by the entry file that composes it. */
export type StartServer<Server extends StartedServer> = (
  options: HostedServerOptions & { readonly localAccess: LocalAccess }
) => Promise<Server>

/** What a new chat runs on: the model list's chat model when the server started. */
interface StartedOn {
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
}

export interface ConfiguredServer<Server extends StartedServer = StartedServer> {
  readonly server: Server
  /** The data folder, resolved. */
  readonly dataDirectory: string
  readonly startedOn: StartedOn
  /** Owner-level requests, for the process that started the server. */
  readonly request: ServerRequest
  readonly applied: AppliedSettings
  /** The file `arden` reads to reach this server: run it with `ARDEN_DIR` set to `dataDirectory`. */
  readonly accessFile: string
  /** Model requests and tokens of the data folder so far, rewritten after every request. */
  readonly usageFile: string
  readonly stop: () => Promise<void>
}

/**
 * Starts a server with every setting in place before the first message, and
 * publishes the access file the `arden` command reads. The data folder is the
 * caller's own: the owner's `~/.arden` is refused.
 */
export const startConfigured = async <Server extends StartedServer>(
  settings: Settings,
  start: StartServer<Server>,
  env: NodeJS.ProcessEnv = process.env
): Promise<ConfiguredServer<Server>> => {
  const dataDirectory = resolve(settings.dataDirectory)
  if (dataDirectory === ownerDataDirectory())
    throw new SettingsError(
      "dataDirectory is the owner's own Arden folder; a configured server needs its own"
    )
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const options = serverOptionsFor(settings)
  const usageFile = join(dataDirectory, USAGE_FILE)
  const route = await modelsFor(settings, { env, fetch: globalThis.fetch })
  const startedOn = chatModelOf(await route.modelHost)
  const models =
    route.provider === undefined
      ? route
      : {
          ...route,
          provider: meteredProvider(route.provider, {
            file: usageFile,
            maxModelRequests: settings.maxModelRequests,
            toolSearch: settings.toolSearch
          })
        }
  const owner = randomBytes(32).toString("base64url")
  const commandLine = randomBytes(32).toString("base64url")
  const server = await start({
    ...options,
    ...models,
    localAccess: {
      host: "configured",
      capability: owner,
      rendererOrigin: "http://127.0.0.1",
      cliCapability: commandLine,
      phoneCapability: randomBytes(32).toString("base64url")
    }
  })
  const accessFile = cliAccessPath(options.databasePath)
  const request: ServerRequest = (path, init) =>
    server.fetch(path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), [LOCAL_CAPABILITY_HEADER]: owner }
    })
  try {
    const applied = await applySettings({
      request,
      settings,
      env,
      ...(settings.keepAutomations === undefined
        ? {}
        : { keepAutomations: settings.keepAutomations })
    })
    await publishCliAccess(accessFile, {
      version: 1,
      serverUrl: server.url.href,
      capability: owner,
      pid: process.pid
    })
    return {
      server,
      dataDirectory,
      startedOn,
      request,
      applied,
      accessFile,
      usageFile,
      stop: async () => {
        await withdrawCliAccess(accessFile, owner).catch(() => undefined)
        await server.stop()
      }
    }
  } catch (cause) {
    await server.stop().catch(() => undefined)
    throw cause
  }
}

const chatModelOf = (host: ModelHost | undefined): StartedOn => {
  const id = host?.defaults.chatModelId ?? undefined
  const model = host?.models.find((entry) => entry.id === id)
  // `modelsFor` always lists the chat model first and names it the default.
  if (model === undefined) throw new Error("The model list names no chat model")
  return { provider: model.provider.id, model: model.id, contextWindow: model.context.hardLimit }
}

/** The line a configured server prints on stdout once ready (`ConfiguredServerReady`). */
export const readyLine = (configured: ConfiguredServer): ConfiguredServerReady => ({
  type: "ready",
  url: configured.server.url.href,
  dataDirectory: configured.dataDirectory,
  accessFile: configured.accessFile,
  usageFile: configured.usageFile,
  ...(configured.applied.offeredTools === undefined
    ? {}
    : { offeredTools: configured.applied.offeredTools }),
  toolsWithoutRule: configured.applied.toolsWithoutRule,
  mcpServers: configured.applied.mcpServers,
  ...configured.startedOn
})
