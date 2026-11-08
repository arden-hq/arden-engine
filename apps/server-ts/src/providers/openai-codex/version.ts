import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { isErrnoCode } from "../../fs/private-store.js"
import { codexHome } from "./cli-login.js"

export type HttpGet = (
  url: string,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly signal?: AbortSignal }
) => Promise<Response>

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/))
const Cache = Schema.fromJsonString(Schema.Struct({ client_version: Version }))
const Package = Schema.Struct({ version: Version })

export interface CodexVersionOptions {
  readonly httpGet: HttpGet
  readonly cachePath?: string
}

export const resolveCodexClientVersion = async (options: CodexVersionOptions): Promise<string> => {
  const cachePath = options.cachePath ?? join(codexHome(), "models_cache.json")
  const cached = await readFile(cachePath, "utf8").catch((cause: unknown) => {
    if (isErrnoCode(cause, "ENOENT")) return undefined
    throw cause
  })
  if (cached !== undefined) return Schema.decodeUnknownSync(Cache)(cached).client_version

  const response = await options.httpGet("https://registry.npmjs.org/@openai/codex/latest", {
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok)
    throw new Error(`Could not discover Codex client version (HTTP ${response.status})`)
  return Schema.decodeUnknownSync(Package)(await response.json()).version
}
