import { LOCAL_CAPABILITY_HEADER } from "@arden-hq/protocol/daemon"
import { randomBytes } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { HostedServerOptions } from "../config/options.js"
import { ownerDataDirectory } from "../config/service.js"
import { cliAccessPath, publishCliAccess, withdrawCliAccess } from "../runtime/cli-access.js"
import { startServerWithLocalAccess, type ServerHandle } from "../server.js"
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
> => ({
  port: settings.port ?? 0,
  databasePath: join(settings.dataDirectory, "arden.db"),
  ...(settings.maxSteps === undefined ? {} : { maxRunSteps: settings.maxSteps }),
  ...(settings.memory === undefined ? {} : { memory: settings.memory }),
  ...(settings.skillRoots === undefined ? {} : { sharedSkillRoots: settings.skillRoots }),
  ...(settings.commandSandbox === undefined ? {} : { commandSandbox: settings.commandSandbox }),
  ...(settings.idleCompactionAfterMs === undefined
    ? {}
    : { idleCompactionAfterMs: settings.idleCompactionAfterMs })
})

export interface ConfiguredServer {
  readonly server: ServerHandle
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
export const startConfigured = async (
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env
): Promise<ConfiguredServer> => {
  const dataDirectory = resolve(settings.dataDirectory)
  if (dataDirectory === ownerDataDirectory())
    throw new SettingsError(
      "dataDirectory is the owner's own Arden folder; a configured server needs its own"
    )
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const options = serverOptionsFor(settings)
  const models = await modelsFor(settings, env)
  // Two secrets, as in the app. The owner one reaches every route and never
  // leaves this process: it applies the settings. The command-line one reaches
  // only what `arden` needs and is the one published in the access file.
  const owner = randomBytes(32).toString("base64url")
  const commandLine = randomBytes(32).toString("base64url")
  const server = await startServerWithLocalAccess({
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
      capability: commandLine,
      pid: process.pid
    })
    return {
      server,
      request,
      applied,
      accessFile,
      stop: async () => {
        await withdrawCliAccess(accessFile, commandLine).catch(() => undefined)
        await server.stop()
      }
    }
  } catch (cause) {
    await server.stop().catch(() => undefined)
    throw cause
  }
}
