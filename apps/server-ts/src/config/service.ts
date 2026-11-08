import { ARDEN_DIR_VARIABLE, resolveArdenDir } from "@arden-hq/std/paths"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { Option } from "effect"
import type { ServerOptions } from "./options.js"

const DEFAULT_HOSTNAME = "127.0.0.1"
const DEFAULT_PORT = 6877
const DEFAULT_IDLE_COMPACTION_AFTER_MS = 5 * 60_000
const DEFAULT_VERSION = "0.0.0-dev"
const IN_MEMORY_DATABASE = ":memory:"
const AGENTS_SKILLS_DIRECTORY = join(homedir(), ".agents", "skills")

export type DataLocation =
  | { readonly kind: "disk"; readonly databasePath: string }
  | { readonly kind: "ephemeral"; readonly managedOutputRoot: string }

const defaultSharedSkillRoots = (data: DataLocation): ReadonlyArray<string> =>
  data.kind === "disk" ? [AGENTS_SKILLS_DIRECTORY] : []

export interface ServerConfigShape {
  readonly hostname: string
  readonly port: number
  readonly version: string
  readonly idleCompactionAfterMs: number
  readonly data: DataLocation
  readonly llamaServer?: string
  readonly sharedSkillRoots: ReadonlyArray<string>
}

const isOnDisk = (databasePath: string | undefined): databasePath is string =>
  databasePath !== undefined && databasePath !== IN_MEMORY_DATABASE

const ServerOptionsSchema = Schema.Struct({
  hostname: Schema.optionalKey(Schema.Literals(["127.0.0.1", "::1", "localhost"] as const)),
  port: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65535))
  ),
  idleCompactionAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  version: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  databasePath: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  managedOutputRoot: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  llamaServer: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  sharedSkillRoots: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1))))
})

const decodeOptions = Schema.decodeUnknownEffect(ServerOptionsSchema)

const DataLocationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disk"), databasePath: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("ephemeral"),
    managedOutputRoot: Schema.String.check(Schema.isMinLength(1))
  })
])

const decodeDataLocation = (options: typeof ServerOptionsSchema.Type) =>
  Schema.decodeUnknownEffect(DataLocationSchema)(
    isOnDisk(options.databasePath)
      ? { kind: "disk", databasePath: options.databasePath }
      : { kind: "ephemeral", managedOutputRoot: options.managedOutputRoot }
  )

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@arden-hq/server/config/ServerConfig"
) {}

type ServerConfigInput = Pick<
  ServerOptions,
  | "hostname"
  | "port"
  | "version"
  | "databasePath"
  | "managedOutputRoot"
  | "llamaServer"
  | "sharedSkillRoots"
  | "idleCompactionAfterMs"
>

const fromOptions = Effect.fn("ServerConfig.fromOptions")(function* (
  options: ServerConfigInput | undefined
) {
  const parsed = yield* decodeOptions(options ?? {})
  const data = yield* decodeDataLocation(parsed)
  return ServerConfig.of({
    hostname: parsed.hostname ?? DEFAULT_HOSTNAME,
    port: parsed.port ?? DEFAULT_PORT,
    version: parsed.version ?? DEFAULT_VERSION,
    idleCompactionAfterMs: parsed.idleCompactionAfterMs ?? DEFAULT_IDLE_COMPACTION_AFTER_MS,
    data,
    ...(parsed.llamaServer === undefined ? {} : { llamaServer: resolve(parsed.llamaServer) }),
    sharedSkillRoots: (parsed.sharedSkillRoots ?? defaultSharedSkillRoots(data)).map((root) =>
      resolve(root)
    )
  })
})

export const layer = (options?: ServerConfigInput): Layer.Layer<ServerConfig, Schema.SchemaError> =>
  Layer.effect(ServerConfig, fromOptions(options))

const environmentConfig = Config.all({
  idleCompactionAfterMs: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    "ARDEN_IDLE_COMPACTION_AFTER_MS"
  ).pipe(Config.withDefault(DEFAULT_IDLE_COMPACTION_AFTER_MS)),
  hostname: Config.string("ARDEN_HOST").pipe(Config.withDefault(DEFAULT_HOSTNAME)),
  port: Config.int("ARDEN_PORT").pipe(Config.withDefault(DEFAULT_PORT)),
  version: Config.string("ARDEN_VERSION").pipe(Config.withDefault(DEFAULT_VERSION)),
  ardenDirectory: Config.option(Config.string(ARDEN_DIR_VARIABLE)),
  databasePath: Config.option(Config.string("ARDEN_DATABASE_PATH")),
  llamaServer: Config.option(Config.string("ARDEN_LLAMA_SERVER"))
}).pipe(
  Config.map(({ ardenDirectory, databasePath, llamaServer, ...options }) => {
    const resolvedLlamaServer = Option.getOrUndefined(llamaServer)
    return {
      ...options,
      databasePath: Option.getOrElse(databasePath, () =>
        join(
          resolveArdenDir({ [ARDEN_DIR_VARIABLE]: Option.getOrUndefined(ardenDirectory) }),
          "arden.db"
        )
      ),
      ...(resolvedLlamaServer === undefined ? {} : { llamaServer: resolvedLlamaServer })
    }
  })
)

export const layerFromEnv = Layer.effect(
  ServerConfig,
  environmentConfig.pipe(Effect.flatMap((options) => fromOptions(options)))
)
