import type {
  LocalModelInfo,
  LocalModelInstall,
  LocalModelsStatus
} from "@arden-hq/protocol/local-models"
import { Context, Effect, FiberMap, Layer, Schema } from "effect"
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises"
import path from "node:path"

import { LOCAL_DECISION_MODELS, LOCAL_MODEL_CATALOG } from "./catalog.js"
import { bytesOnDisk, installedState, installModel, removeModel } from "./download.js"
import { makeLocalDecisionEndpoint } from "./local-decision-endpoint.js"
import { LocalDecisionEndpoint } from "../models/decisions/local.js"
import { LlamaServer } from "./llama-server.js"
import type { ModelManifest } from "./manifest.js"
import type { PresetModel } from "./models-preset.js"
import { WikiEmbeddingIndex } from "../embedding/wiki-index.js"

export class LocalModelNotFound extends Schema.TaggedError<LocalModelNotFound>()(
  "LocalModelNotFound",
  { id: Schema.String }
) {}

export class LocalModelInUse extends Schema.TaggedError<LocalModelInUse>()("LocalModelInUse", {
  id: Schema.String
}) {}

export class LocalModelsError extends Schema.TaggedError<LocalModelsError>()("LocalModelsError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class LocalModels extends Context.Service<
  LocalModels,
  {
    readonly status: () => Effect.Effect<LocalModelsStatus>
    readonly install: (id: string) => Effect.Effect<LocalModelsStatus, LocalModelNotFound>
    readonly stop: (id: string) => Effect.Effect<LocalModelsStatus, LocalModelNotFound>
    readonly remove: (
      id: string
    ) => Effect.Effect<LocalModelsStatus, LocalModelNotFound | LocalModelInUse | LocalModelsError>
    /** The installed decision model as an endpoint; undefined when none is installed. Cheap. */
  }
>()("@arden-hq/server/local-models/LocalModels") {}

const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024
const RESUME_DELAY = "10 seconds"

type Live =
  | { readonly state: "downloading"; readonly receivedBytes: number; readonly totalBytes: number }
  | Extract<LocalModelInstall, { state: "failed" | "no_space" }>

const totalBytesOf = (manifest: ModelManifest) =>
  manifest.files.reduce((sum, file) => sum + file.bytes, 0)

const ResumeSchema = Schema.fromJsonString(Schema.Struct({ resume: Schema.Array(Schema.String) }))

const isNoSpace = (error: unknown): boolean => {
  let current: unknown = error
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && current.code === "ENOSPC") return true
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

const failureReason = (reason: string): "network" | "hash" | "disk" => {
  switch (reason) {
    case "http":
    case "incomplete":
      return "network"
    case "hash":
    case "size":
      return "hash"
    default:
      return "disk"
  }
}

const freeBytesAt = (directory: string) =>
  Effect.promise(() =>
    statfs(directory).then(
      (stats) => stats.bavail * stats.bsize,
      () => undefined
    )
  )

export const localModelsLayer = (options: {
  readonly root: string
}): Layer.Layer<LocalModels, never, LlamaServer | WikiEmbeddingIndex> =>
  Layer.effect(
    LocalModels,
    Effect.gen(function* () {
      const llama = yield* LlamaServer
      const embeddings = yield* WikiEmbeddingIndex
      const downloads = yield* FiberMap.make<string>()
      const live = new Map<string, Live>()
      const installed = new Set<string>()
      const resumeFile = path.join(options.root, "downloads.json")
      const byId = new Map(LOCAL_MODEL_CATALOG.map((manifest) => [manifest.id, manifest] as const))

      const find = (id: string): Effect.Effect<ModelManifest, LocalModelNotFound> => {
        const manifest = byId.get(id)
        return manifest === undefined
          ? Effect.fail(new LocalModelNotFound({ id }))
          : Effect.succeed(manifest)
      }

      const readResume = Effect.promise(() => readFile(resumeFile, "utf8").catch(() => "")).pipe(
        Effect.flatMap((text) => Schema.decodeUnknownEffect(ResumeSchema)(text)),
        Effect.map((value) => new Set(value.resume)),
        Effect.orElseSucceed(() => new Set<string>())
      )
      const writeResume = (change: (ids: Set<string>) => void) =>
        readResume.pipe(
          Effect.flatMap((ids) => {
            change(ids)
            return Effect.promise(() =>
              mkdir(options.root, { recursive: true })
                .then(() => writeFile(resumeFile, JSON.stringify({ resume: [...ids] })))
                .catch(() => undefined)
            )
          })
        )

      const refreshInstalled = (manifest: ModelManifest) =>
        installedState({ manifest, root: options.root }).pipe(
          Effect.tap((state) =>
            Effect.sync(() => {
              if (state === "installed") installed.add(manifest.id)
              else installed.delete(manifest.id)
            })
          )
        )
      yield* Effect.forEach(LOCAL_MODEL_CATALOG, refreshInstalled, { discard: true })

      const installOf = Effect.fn("LocalModels.installOf")(function* (manifest: ModelManifest) {
        const current = live.get(manifest.id)
        if (current !== undefined) return current
        if (installed.has(manifest.id)) return { state: "installed" } as const
        const received = yield* bytesOnDisk({ manifest, root: options.root })
        return received === 0
          ? ({ state: "absent" } as const)
          : ({
              state: "stopped",
              receivedBytes: received,
              totalBytes: totalBytesOf(manifest)
            } as const)
      })

      const status = Effect.fn("LocalModels.status")(function* () {
        const models = yield* Effect.forEach(
          LOCAL_MODEL_CATALOG,
          (manifest): Effect.Effect<LocalModelInfo> =>
            installOf(manifest).pipe(
              Effect.map((install) => ({
                id: manifest.id,
                kind: manifest.kind,
                name: manifest.name,
                license: manifest.license.name,
                licenseUrl: manifest.license.url,
                input: manifest.input,
                totalBytes: totalBytesOf(manifest),
                dimensions: manifest.kind === "embedding" ? manifest.dimensions : null,
                install
              }))
            )
        )
        yield* Effect.promise(() => mkdir(options.root, { recursive: true }).catch(() => undefined))
        const free = yield* freeBytesAt(options.root)
        return { models, freeBytes: free ?? null, runtime: yield* llama.runtime() }
      })

      const adoptForSearch = (manifest: ModelManifest) =>
        manifest.kind !== "embedding"
          ? Effect.void
          : embeddings.status().pipe(
              Effect.flatMap((search) =>
                search.state === "idle"
                  ? embeddings.control({ kind: "choose", modelId: manifest.id })
                  : Effect.void
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not switch search to the downloaded model", cause)
              )
            )

      const markInstalled = Effect.fn("LocalModels.installed")(function* (manifest: ModelManifest) {
        live.delete(manifest.id)
        yield* refreshInstalled(manifest)
        yield* writeResume((ids) => ids.delete(manifest.id))
        yield* llama.restart()
        yield* adoptForSearch(manifest)
      })

      const failed = Effect.fn("LocalModels.failed")(function* (
        manifest: ModelManifest,
        error: { readonly reason: string }
      ) {
        const totalBytes = totalBytesOf(manifest)
        const receivedBytes = yield* bytesOnDisk({ manifest, root: options.root })
        const noSpace = isNoSpace(error)
        if (noSpace) {
          live.set(manifest.id, {
            state: "no_space",
            neededBytes: totalBytes - receivedBytes + DISK_HEADROOM_BYTES,
            freeBytes: (yield* freeBytesAt(options.root)) ?? 0
          })
        } else {
          live.set(manifest.id, {
            state: "failed",
            reason: failureReason(error.reason),
            receivedBytes,
            totalBytes
          })
        }
        if (noSpace || failureReason(error.reason) !== "network") {
          yield* writeResume((ids) => ids.delete(manifest.id))
        }
        yield* Effect.logWarning("A local model download failed", { id: manifest.id, error })
      })

      const download = Effect.fn("LocalModels.download")(function* (manifest: ModelManifest) {
        const totalBytes = totalBytesOf(manifest)
        live.set(manifest.id, {
          state: "downloading",
          receivedBytes: yield* bytesOnDisk({ manifest, root: options.root }),
          totalBytes
        })
        yield* installModel({
          manifest,
          root: options.root,
          onProgress: (progress) =>
            live.set(manifest.id, {
              state: "downloading",
              receivedBytes: progress.receivedBytes,
              totalBytes
            })
        }).pipe(
          Effect.matchEffect({
            onSuccess: () => markInstalled(manifest),
            onFailure: (error) => failed(manifest, error)
          }),
          Effect.onInterrupt(() => Effect.sync(() => live.delete(manifest.id)))
        )
      })

      const start = Effect.fn("LocalModels.start")(function* (manifest: ModelManifest) {
        if (installed.has(manifest.id) || (yield* FiberMap.has(downloads, manifest.id))) return
        const neededBytes =
          totalBytesOf(manifest) - (yield* bytesOnDisk({ manifest, root: options.root }))
        yield* Effect.promise(() => mkdir(options.root, { recursive: true }).catch(() => undefined))
        const free = yield* freeBytesAt(options.root)
        if (free !== undefined && free < neededBytes + DISK_HEADROOM_BYTES) {
          live.set(manifest.id, {
            state: "no_space",
            neededBytes: neededBytes + DISK_HEADROOM_BYTES,
            freeBytes: free
          })
          return
        }
        yield* writeResume((ids) => ids.add(manifest.id))
        live.set(manifest.id, {
          state: "downloading",
          receivedBytes: totalBytesOf(manifest) - neededBytes,
          totalBytes: totalBytesOf(manifest)
        })
        yield* FiberMap.run(downloads, manifest.id, { onlyIfMissing: true })(download(manifest))
      })

      yield* Effect.forkScoped(
        Effect.sleep(RESUME_DELAY).pipe(
          Effect.andThen(readResume),
          Effect.flatMap((ids) =>
            Effect.forEach(
              [...ids].flatMap((id) => {
                const manifest = byId.get(id)
                return manifest === undefined ? [] : [manifest]
              }),
              start,
              { discard: true }
            )
          )
        )
      )

      const remove = Effect.fn("LocalModels.remove")(function* (id: string) {
        const manifest = yield* find(id)
        const search = yield* embeddings.status().pipe(Effect.orElseSucceed(() => undefined))
        const inUse =
          search !== undefined &&
          search.state !== "idle" &&
          (search.modelId === id || search.previousModelId === id)
        if (inUse) return yield* new LocalModelInUse({ id })
        yield* FiberMap.remove(downloads, id)
        yield* writeResume((ids) => ids.delete(id))
        live.delete(id)
        const wasInstalled = installed.delete(id)
        yield* removeModel({ manifest, root: options.root }).pipe(
          Effect.mapError((cause) => new LocalModelsError({ message: cause.message, cause }))
        )
        if (wasInstalled) yield* llama.restart()
        return yield* status()
      })

      return LocalModels.of({
        status,
        install: (id) =>
          find(id).pipe(
            Effect.tap((manifest) =>
              FiberMap.has(downloads, manifest.id).pipe(
                Effect.tap((running) => Effect.sync(() => running || live.delete(manifest.id)))
              )
            ),
            Effect.flatMap(start),
            Effect.andThen(status())
          ),
        stop: (id) =>
          find(id).pipe(
            Effect.tap((manifest) =>
              FiberMap.remove(downloads, manifest.id).pipe(
                Effect.andThen(writeResume((ids) => ids.delete(manifest.id))),
                Effect.andThen(Effect.sync(() => live.delete(manifest.id)))
              )
            ),
            Effect.andThen(status())
          ),
        remove
      })
    })
  )

export const installedPresetModels = (root: string): Effect.Effect<ReadonlyArray<PresetModel>> =>
  Effect.filter(LOCAL_MODEL_CATALOG, (manifest) =>
    installedState({ manifest, root }).pipe(Effect.map((state) => state === "installed"))
  ).pipe(
    Effect.map((manifests) =>
      manifests.map((manifest) => ({ manifest, directory: path.join(root, manifest.id) }))
    )
  )

export const isInstalled = (root: string, manifest: ModelManifest): Effect.Effect<boolean> =>
  installedState({ manifest, root }).pipe(Effect.map((state) => state === "installed"))

export const localDecisionEndpointLayer = (root: string) =>
  Layer.effect(
    LocalDecisionEndpoint,
    Effect.gen(function* () {
      const manifest = LOCAL_DECISION_MODELS[0]
      const endpoint =
        manifest === undefined ? undefined : yield* makeLocalDecisionEndpoint(manifest)
      return LocalDecisionEndpoint.of({
        endpoint: () =>
          manifest === undefined || endpoint === undefined
            ? Effect.succeed(undefined)
            : isInstalled(root, manifest).pipe(Effect.map((ok) => (ok ? endpoint : undefined)))
      })
    })
  )
