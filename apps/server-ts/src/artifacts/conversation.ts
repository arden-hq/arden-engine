import { parseJsonText } from "@arden-hq/protocol/common"
import { formatBytes } from "@arden-hq/std/count"
import { randomUUID } from "node:crypto"
import { VISUALIZATION_RUNTIME_VERSION } from "@arden-hq/protocol"
import { VISUALIZATION_KIND } from "@arden-hq/protocol/visualizations"
import { VisualizationRefSchema } from "@arden-hq/protocol/effect/visualizations"
import { chmod, cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"

import { isErrnoCode, readRegularFile, writeNewFile } from "../fs/private-store.js"
import { currentIso } from "../runtime/clock.js"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  MAX_BYTES,
  SessionIdSchema,
  type ConversationArtifactManifest,
  type CreateImageArtifactInput,
  type CreateFileArtifactInput,
  type ConversationArtifact,
  isHtmlArtifact,
  ConversationArtifactError
} from "./conversation-model.js"
import {
  artifactError,
  filesystem,
  artifactRef,
  fileArtifactRef,
  detectImage,
  decodeManifest,
  readArtifactFile,
  writeArtifact,
  REMOVED_PREFIX,
  sweepRemoved
} from "./conversation-files.js"

const make = Effect.fn("ConversationArtifacts.make")(function* (root: string) {
  const permits = new Map<string, Semaphore.Semaphore>()
  const permit = (sessionId: string) => {
    const existing = permits.get(sessionId)
    if (existing !== undefined) return existing
    const created = Effect.runSync(Semaphore.make(1))
    permits.set(sessionId, created)
    return created
  }
  const validateSessionId = (sessionId: string) =>
    Schema.decodeUnknownEffect(SessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) => artifactError("invalid", "Session reference is invalid", cause))
    )
  const validateRef = (ref: string) =>
    Schema.decodeUnknownEffect(VisualizationRefSchema)(ref).pipe(
      Effect.mapError((cause) =>
        artifactError("invalid", "Visualization reference is invalid", cause)
      )
    )
  const artifactDirectory = (sessionId: string, ref: string): string =>
    join(root, sessionId, "artifacts", ref)

  const createImage = Effect.fn("ConversationArtifacts.createImage")(function* (
    input: CreateImageArtifactInput
  ) {
    const sessionId = yield* validateSessionId(input.sessionId)
    if (input.source.kind === "path" && !isAbsolute(input.source.path)) {
      return yield* artifactError("invalid", "Visualization image path must be absolute")
    }
    const bytes =
      input.source.kind === "path"
        ? yield* readArtifactFile(input.source.path, MAX_IMAGE_BYTES)
        : Uint8Array.from(input.source.bytes)
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return yield* artifactError(
        "quota",
        `Visualization image exceeds ${formatBytes(MAX_IMAGE_BYTES)}`
      )
    }
    const image = detectImage(bytes)
    if (image === null) {
      return yield* artifactError("invalid", "Visualization image must be PNG, JPEG, GIF, or WebP")
    }
    const ref = artifactRef(sessionId, input.toolCallId)
    const manifest: ConversationArtifactManifest = {
      version: 2,
      runtime_version: VISUALIZATION_RUNTIME_VERSION,
      libraries: [],
      ref,
      kind: "image",
      title: input.title,
      summary: input.summary,
      mode: input.mode,
      media_type: image.mediaType,
      filename: image.filename,
      byte_length: bytes.byteLength,
      sha256: sha256Hex(bytes),
      created_at: currentIso(),
      ...(input.capture === undefined ? {} : { capture: input.capture }),
      producer_run_id: input.producerRunId,
      role: input.role
    }
    return yield* permit(sessionId).withPermit(
      writeArtifact(join(root, sessionId, "artifacts"), manifest, bytes)
    )
  })

  const createFile = Effect.fn("ConversationArtifacts.createFile")(function* (
    input: CreateFileArtifactInput
  ) {
    const sessionId = yield* validateSessionId(input.sessionId)
    if (input.source.kind === "path" && !isAbsolute(input.source.path)) {
      return yield* artifactError("invalid", "Artifact source path must be absolute")
    }
    const bytes =
      input.source.kind === "path"
        ? yield* readArtifactFile(input.source.path, MAX_FILE_BYTES)
        : Uint8Array.from(input.source.bytes)
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return yield* artifactError("quota", `Artifact file exceeds ${formatBytes(MAX_FILE_BYTES)}`)
    }
    const sourceName =
      input.source.kind === "path" ? basename(input.source.path) : input.source.filename
    if (
      sourceName.length === 0 ||
      sourceName.length > 255 ||
      sourceName.includes("/") ||
      sourceName.includes("\\")
    ) {
      return yield* artifactError("invalid", "Artifact filename is invalid")
    }
    const ref = fileArtifactRef(sessionId, input.operationKey)
    const manifest: ConversationArtifactManifest = {
      version: 2,
      runtime_version: VISUALIZATION_RUNTIME_VERSION,
      libraries: [],
      ref,
      kind: "file",
      title: input.title,
      summary: input.summary,
      mode: "normal",
      media_type: input.mediaType,
      filename: sourceName,
      byte_length: bytes.byteLength,
      sha256: sha256Hex(bytes),
      created_at: currentIso(),
      producer_run_id: input.producerRunId,
      operation_key: input.operationKey,
      role: input.role
    }
    return yield* permit(sessionId).withPermit(
      writeArtifact(join(root, sessionId, "artifacts"), manifest, bytes)
    )
  })

  const readManifest = Effect.fn("ConversationArtifacts.readManifest")(function* (
    sessionId: string,
    ref: string
  ) {
    const owner = yield* validateSessionId(sessionId)
    const artifact = yield* validateRef(ref)
    const directory = artifactDirectory(owner, artifact)
    const manifestBytes = yield* readArtifactFile(join(directory, "manifest.json"), 16 * 1024)
    const manifest = yield* Effect.try({
      try: () => parseJsonText(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
      catch: (cause) =>
        artifactError("corrupt", "Visualization manifest is not valid UTF-8 JSON", cause)
    }).pipe(Effect.flatMap(decodeManifest))
    if (manifest.ref !== artifact) {
      return yield* artifactError("corrupt", "Visualization manifest does not match its reference")
    }
    const expectedHtml = manifest.kind === VISUALIZATION_KIND.html && isHtmlArtifact(manifest)
    const expectedImage = manifest.kind === "image" && manifest.filename.startsWith("image.")
    const expectedFile =
      manifest.kind === "file" &&
      manifest.producer_run_id !== undefined &&
      manifest.operation_key !== undefined
    if (!expectedHtml && !expectedImage && !expectedFile) {
      return yield* artifactError("corrupt", "Visualization manifest content type is invalid")
    }
    return manifest
  })

  const path = Effect.fn("ConversationArtifacts.path")(function* (sessionId: string, ref: string) {
    const manifest = yield* readManifest(sessionId, ref)
    return join(artifactDirectory(sessionId, ref), manifest.filename)
  })

  const rootPath = Effect.fn("ConversationArtifacts.rootPath")(function* (sessionId: string) {
    const owner = yield* validateSessionId(sessionId)
    return join(root, owner, "artifacts")
  })

  const list = Effect.fn("ConversationArtifacts.list")(function* (sessionId: string) {
    const owner = yield* validateSessionId(sessionId)
    const entries = yield* filesystem("Conversation artifacts could not be listed", () =>
      readdir(join(root, owner, "artifacts"), { withFileTypes: true })
    ).pipe(
      Effect.catch((failure) =>
        isErrnoCode(failure.cause, "ENOENT") ? Effect.succeed([]) : Effect.fail(failure)
      )
    )
    yield* sweepRemoved(join(root, owner, "artifacts"))
    const manifests = yield* Effect.forEach(
      entries.filter(
        (entry) => entry.isDirectory() && Schema.is(VisualizationRefSchema)(entry.name)
      ),
      (entry) => readManifest(owner, entry.name),
      { concurrency: 8 }
    )
    return manifests.sort(
      (a, b) => b.created_at.localeCompare(a.created_at) || a.ref.localeCompare(b.ref)
    )
  })

  const read = Effect.fn("ConversationArtifacts.read")(function* (sessionId: string, ref: string) {
    const manifest = yield* readManifest(sessionId, ref)
    const directory = artifactDirectory(sessionId, ref)
    const bytes = yield* readArtifactFile(
      join(directory, manifest.filename),
      MAX_BYTES[manifest.kind]
    )
    if (bytes.byteLength !== manifest.byte_length || sha256Hex(bytes) !== manifest.sha256) {
      return yield* artifactError("corrupt", "Visualization content does not match its manifest")
    }
    if (manifest.kind === "image") {
      const detected = detectImage(bytes)
      if (detected?.filename !== manifest.filename || detected.mediaType !== manifest.media_type) {
        return yield* artifactError(
          "corrupt",
          "Visualization image type does not match its manifest"
        )
      }
    }
    return { manifest, bytes } satisfies ConversationArtifact
  })

  const branch = Effect.fn("ConversationArtifacts.branch")(function* (
    fromSessionId: string,
    toSessionId: string
  ) {
    const source = yield* validateSessionId(fromSessionId)
    const destination = yield* validateSessionId(toSessionId)
    if (source === destination) {
      return yield* artifactError("invalid", "A chat cannot copy its artifacts onto itself")
    }
    const first = source < destination ? source : destination
    const second = source < destination ? destination : source
    return yield* permit(first).withPermit(
      permit(second).withPermit(
        filesystem("Conversation artifacts could not be prepared", async () => {
          const target = join(root, destination)
          const marker = ".fork-source"
          const existing = await lstat(target).catch((cause: unknown) => {
            if (isErrnoCode(cause, "ENOENT")) return undefined
            throw cause
          })
          if (existing !== undefined) {
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
              throw new Error("The fork artifact directory is invalid")
            }
            const prepared = await readRegularFile(join(target, marker), 200)
            if (prepared.bytes.toString("utf8") !== source) {
              throw new Error("The fork artifact directory belongs to another source")
            }
            return
          }
          const staging = join(root, `.${destination}.fork-preparing`)
          await mkdir(root, { recursive: true, mode: 0o700 })
          await rm(staging, { recursive: true, force: true })
          const sourceDirectory = join(root, source)
          const sourceStatus = await lstat(sourceDirectory).catch((cause: unknown) => {
            if (isErrnoCode(cause, "ENOENT")) return undefined
            throw cause
          })
          if (sourceStatus !== undefined) {
            if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
              throw new Error("The source artifact directory is invalid")
            }
            await cp(sourceDirectory, staging, {
              recursive: true,
              errorOnExist: true,
              force: false,
              verbatimSymlinks: false,
              filter: async (sourcePath) => {
                if (
                  sourcePath === join(sourceDirectory, marker) ||
                  basename(sourcePath).startsWith(".artifact-")
                )
                  return false
                const status = await lstat(sourcePath)
                if (status.isSymbolicLink())
                  throw new Error("Conversation artifacts must not contain symbolic links")
                return true
              }
            })
          } else {
            await mkdir(staging, { mode: 0o700 })
          }
          await writeNewFile(join(staging, marker), source)
          await chmod(staging, 0o700)
          await rename(staging, target)
        })
      )
    )
  })

  const removeArtifact = Effect.fn("ConversationArtifacts.removeArtifact")(function* (
    sessionId: string,
    ref: string
  ) {
    const owner = yield* validateSessionId(sessionId)
    return yield* permit(owner).withPermit(
      Effect.gen(function* () {
        const manifest = yield* readManifest(owner, ref)
        const folder = join(root, owner, "artifacts")
        yield* filesystem("Artifact could not be removed", () =>
          rename(
            artifactDirectory(owner, manifest.ref),
            join(folder, `${REMOVED_PREFIX}${randomUUID()}`)
          )
        )
        const left = yield* sweepRemoved(folder)
        return { manifest, bytesRemoved: left === 0 }
      })
    )
  })

  const remove = Effect.fn("ConversationArtifacts.remove")(function* (sessionId: string) {
    const owner = yield* validateSessionId(sessionId)
    yield* permit(owner).withPermit(
      filesystem("Conversation artifacts could not be removed", async () => {
        await rm(join(root, owner), { recursive: true, force: true, maxRetries: 2 })
        await rm(join(root, `.${owner}.fork-preparing`), {
          recursive: true,
          force: true,
          maxRetries: 2
        })
      })
    )
  })

  return ConversationArtifacts.of({
    createImage,
    createFile,
    manifest: readManifest,
    path,
    rootPath,
    read,
    list,
    branch,
    removeArtifact,
    remove
  })
})

export class ConversationArtifacts extends Context.Service<
  ConversationArtifacts,
  {
    readonly createImage: (
      input: CreateImageArtifactInput
    ) => Effect.Effect<ConversationArtifactManifest, ConversationArtifactError>
    readonly createFile: (
      input: CreateFileArtifactInput
    ) => Effect.Effect<ConversationArtifactManifest, ConversationArtifactError>
    readonly manifest: (
      sessionId: string,
      ref: string
    ) => Effect.Effect<ConversationArtifactManifest, ConversationArtifactError>
    readonly path: (
      sessionId: string,
      ref: string
    ) => Effect.Effect<string, ConversationArtifactError>
    readonly rootPath: (sessionId: string) => Effect.Effect<string, ConversationArtifactError>
    readonly read: (
      sessionId: string,
      ref: string
    ) => Effect.Effect<ConversationArtifact, ConversationArtifactError>
    readonly list: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<ConversationArtifactManifest>, ConversationArtifactError>
    readonly branch: (
      fromSessionId: string,
      toSessionId: string
    ) => Effect.Effect<void, ConversationArtifactError>
    readonly removeArtifact: (
      sessionId: string,
      ref: string
    ) => Effect.Effect<
      { readonly manifest: ConversationArtifactManifest; readonly bytesRemoved: boolean },
      ConversationArtifactError
    >
    readonly remove: (sessionId: string) => Effect.Effect<void, ConversationArtifactError>
  }
>()("@arden-hq/server/artifacts/ConversationArtifacts") {
  static layer(root: string): Layer.Layer<ConversationArtifacts> {
    return Layer.effect(ConversationArtifacts, make(root))
  }
}
