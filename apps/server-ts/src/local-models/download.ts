import { Effect, Schema } from "effect"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { downloadFile, DownloadError } from "../lib/download.js"
import type { ModelManifest } from "./manifest.js"

export interface DownloadProgress {
  readonly modelId: string
  readonly receivedBytes: number
  readonly totalBytes: number
}

const INSTALLED_MARKER = "installed.json"
const modelDirectory = (root: string, modelId: string) => path.join(root, modelId)
const sizeOf = async (file: string): Promise<number | undefined> => {
  const details = await stat(file).catch(() => undefined)
  return details?.isFile() === true ? details.size : undefined
}

export const installModel = Effect.fn("LocalModels.installModel")(function* (options: {
  readonly manifest: ModelManifest
  readonly root: string
  readonly onProgress: (progress: DownloadProgress) => void
}) {
  const { manifest } = options
  const directory = modelDirectory(options.root, manifest.id)
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
  let finishedBytes = 0
  for (const file of manifest.files) {
    yield* downloadFile({
      file,
      destination: path.join(directory, file.path),
      fetch: globalThis.fetch,
      onBytes: (receivedBytes) =>
        options.onProgress({
          modelId: manifest.id,
          receivedBytes: finishedBytes + receivedBytes,
          totalBytes
        })
    })
    finishedBytes += file.bytes
  }
  yield* Effect.tryPromise({
    try: () =>
      writeFile(
        path.join(directory, INSTALLED_MARKER),
        JSON.stringify({ id: manifest.id, files: manifest.files.map((file) => file.sha256) })
      ),
    catch: (cause) =>
      new DownloadError({
        reason: "io",
        path: INSTALLED_MARKER,
        message: "Could not record the installed model",
        cause
      })
  })
})

const InstalledMarkerSchema = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, files: Schema.Array(Schema.String) })
)

export const installedState = Effect.fn("LocalModels.installedState")(function* (options: {
  readonly manifest: ModelManifest
  readonly root: string
}) {
  const directory = modelDirectory(options.root, options.manifest.id)
  const marker = yield* Effect.promise(() =>
    readFile(path.join(directory, INSTALLED_MARKER), "utf8").catch(() => undefined)
  )
  const decoded =
    marker === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(InstalledMarkerSchema)(marker).pipe(
          Effect.orElseSucceed(() => undefined)
        )
  const expected = options.manifest.files.map((file) => file.sha256)
  if (
    decoded?.id === options.manifest.id &&
    decoded.files.length === expected.length &&
    decoded.files.every((sha, index) => sha === expected[index])
  ) {
    return "installed" as const
  }
  const exists = yield* Effect.promise(() =>
    stat(directory).then(
      () => true,
      () => false
    )
  )
  return exists ? ("partial" as const) : ("absent" as const)
})

export const removeModel = Effect.fn("LocalModels.removeModel")(function* (options: {
  readonly manifest: ModelManifest
  readonly root: string
}) {
  yield* Effect.tryPromise({
    try: () =>
      rm(modelDirectory(options.root, options.manifest.id), { recursive: true, force: true }),
    catch: (cause) =>
      new DownloadError({
        reason: "io",
        path: options.manifest.id,
        message: "Could not delete the model files",
        cause
      })
  })
})

export const bytesOnDisk = Effect.fn("LocalModels.bytesOnDisk")(function* (options: {
  readonly manifest: ModelManifest
  readonly root: string
}) {
  const directory = modelDirectory(options.root, options.manifest.id)
  const sizes = yield* Effect.promise(() =>
    Promise.all(
      options.manifest.files.map(async (file) => {
        const destination = path.join(directory, file.path)
        const done = await sizeOf(destination)
        if (done === file.bytes) return done
        return Math.min((await sizeOf(`${destination}.partial`)) ?? 0, file.bytes)
      })
    )
  )
  return sizes.reduce((sum, size) => sum + size, 0)
})
