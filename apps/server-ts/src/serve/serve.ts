import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { randomBytes } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { HostedServerOptions } from "../config/options.js"
import { ownerDataDirectory } from "../config/service.js"
import type { LocalAccess } from "../http/middleware/local-only.js"
import { cliAccessPath, publishCliAccess, withdrawCliAccess } from "../runtime/cli-access.js"
import { applySettings, type AppliedSettings, type ServerRequest } from "./apply.js"
import { modelsFor } from "./models.js"
import { SettingsError, type Settings } from "./settings.js"

/** The start options a settings file stands for; the rest is applied after start. */
export const serverOptionsFor = (
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
> => ({
  port: settings.port ?? 0,
  databasePath: join(settings.dataDirectory, "arden.db"),
  ...(settings.maxSteps === undefined ? {} : { maxRunSteps: settings.maxSteps }),
  ...(settings.memory === undefined ? {} : { memory: settings.memory }),
  ...(settings.approvalMode === undefined ? {} : { approvalMode: settings.approvalMode }),
  ...(settings.skillRoots === undefined ? {} : { sharedSkillRoots: settings.skillRoots }),
  ...(settings.commandSandbox === undefined ? {} : { commandSandbox: settings.commandSandbox }),
  ...(settings.idleCompactionAfterMs === undefined
    ? {}
    : { idleCompactionAfterMs: settings.idleCompactionAfterMs })
})

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

export interface ConfiguredServer<Server extends StartedServer = StartedServer> {
  readonly server: Server
  /** Owner-level requests, for the process that started the server. */
  readonly request: ServerRequest
  readonly applied: AppliedSettings
  /** The file `arden` reads to reach this server: run it with `ARDEN_DIR` set to `dataDirectory`. */
  readonly accessFile: string
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
  const models = await modelsFor(settings, env)
  // Whoever starts a configured server owns it and its data folder, so the
  // access file carries the owner secret: every route, approvals included.
  // The narrower command-line secret the app hands out is made and not used.
  const owner = randomBytes(32).toString("base64url")
  const commandLine = randomBytes(32).toString("base64url")
  const server = await start({
    ...options,
    ...models,
    // No page loads from a configured server, so the renderer origin is unused.
    localAccess: {
      capability: owner,
      rendererOrigin: "http://127.0.0.1",
      cliCapability: commandLine
    }
  })
  const accessFile = cliAccessPath(options.databasePath)
  const request: ServerRequest = (path, init) =>
    server.fetch(path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), [LOCAL_CAPABILITY_HEADER]: owner }
    })
  try {
    const applied = await applySettings({ request, settings, env })
    await publishCliAccess(accessFile, {
      version: 1,
      serverUrl: server.url.href,
      capability: owner,
      pid: process.pid
    })
    return {
      server,
      request,
      applied,
      accessFile,
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
