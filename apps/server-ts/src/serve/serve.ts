import {
  LOCAL_CAPABILITY_HEADER,
  OFFERED_TOOLS,
  type ConfiguredServerReady
} from "@arden-hq/protocol/daemon"
import { randomBytes } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { HostedServerOptions } from "../config/options.js"
import { ownerDataDirectory } from "../config/service.js"
import { LOCAL_ACCESS_HOST, type LocalAccess } from "../http/middleware/local-only.js"
import type { ModelHost } from "../models/host.js"
import { cliAccessPath, publishCliAccess, withdrawCliAccess } from "../runtime/cli-access.js"
import { applySettings, type AppliedSettings, type ServerRequest } from "./apply.js"
import { meteredProvider } from "./meter.js"
import { modelsFor } from "./models.js"
import { SettingsError, type Settings } from "./settings.js"

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

export interface StartedServer {
  readonly url: URL
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly stop: () => Promise<void>
}

export type StartServer<Server extends StartedServer> = (
  options: HostedServerOptions & { readonly localAccess: LocalAccess }
) => Promise<Server>

interface StartedOn {
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
}

export interface ConfiguredServer<Server extends StartedServer = StartedServer> {
  readonly server: Server
  readonly dataDirectory: string
  readonly startedOn: StartedOn
  readonly request: ServerRequest
  readonly applied: AppliedSettings
  readonly accessFile: string
  readonly usageFile: string
  readonly stop: () => Promise<void>
}

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
      host: LOCAL_ACCESS_HOST.configured,
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
  if (model === undefined) throw new Error("The model list names no chat model")
  return { provider: model.provider.id, model: model.id, contextWindow: model.context.hardLimit }
}

export const readyLine = (configured: ConfiguredServer): ConfiguredServerReady => ({
  type: "ready",
  url: configured.server.url.href,
  dataDirectory: configured.dataDirectory,
  accessFile: configured.accessFile,
  usageFile: configured.usageFile,
  offeredTools:
    configured.applied.offeredTools === undefined
      ? { kind: OFFERED_TOOLS.all }
      : { kind: OFFERED_TOOLS.listed, names: configured.applied.offeredTools },
  toolsWithoutRule: configured.applied.toolsWithoutRule,
  mcpServers: configured.applied.mcpServers,
  ...configured.startedOn
})
