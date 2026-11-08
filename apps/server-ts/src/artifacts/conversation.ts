import { formatBytes } from "@arden-hq/std/count"
import { randomUUID } from "node:crypto"
import { VISUALIZATION_RUNTIME_VERSION, type ArtifactRole } from "@arden-hq/protocol"
import {
  ArtifactRoleSchema,
  VisualizationKindSchema,
  VisualizationLibrariesSchema,
  VisualizationModeSchema,
  VisualizationRefSchema
} from "@arden-hq/protocol/effect/visualizations"
import { chmod, cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { Context, Effect, Layer, Schema, Semaphore, Struct } from "effect"

import {
  isErrnoCode,
  PrivateFileError,
  readRegularFile,
  writeNewFile
} from "../fs/private-store.js"
import { currentIso } from "../runtime/clock.js"
import { sha256Hex } from "@arden-hq/std/hash"

const MAX_HTML_BYTES = 150_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_BYTES: Record<"html" | "image" | "file", number> = {
  html: MAX_HTML_BYTES,
  image: MAX_IMAGE_BYTES,
  file: MAX_FILE_BYTES
}

const SessionIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
)

export const ScreenshotCaptureSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(4_096)),
  captured_at: Schema.String.check(Schema.isMaxLength(100))
})

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(2),
  runtime_version: Schema.Literal(VISUALIZATION_RUNTIME_VERSION),
  libraries: VisualizationLibrariesSchema,
  ref: VisualizationRefSchema,
  kind: VisualizationKindSchema,
  title: Schema.String.check(Schema.isMaxLength(200)),
  summary: Schema.String.check(Schema.isMaxLength(500)),
  mode: VisualizationModeSchema,
  media_type: Schema.String,
  filename: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(/^[^/\\]+$/)
  ),
  byte_length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  created_at: Schema.String,
  capture: Schema.optionalKey(ScreenshotCaptureSchema),
  producer_run_id: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
  ),
  operation_key: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))
  ),
  role: Schema.optionalKey(ArtifactRoleSchema)
})

export type ConversationArtifactManifest = typeof ManifestSchema.Type

export const artifactRole = (manifest: ConversationArtifactManifest): ArtifactRole => {
  if (manifest.role !== undefined) return manifest.role
  if (manifest.capture !== undefined) return "working"
  const spilled =
    /^(?:exec_command|bash):/.test(manifest.operation_key ?? "") &&
    (manifest.title === "Command output" || manifest.title === "Bash output")
  return spilled ? "working" : "output"
}

export interface CreateImageArtifactInput {
  readonly sessionId: string
  readonly producerRunId: string
  readonly toolCallId: string
  readonly source:
    | { readonly kind: "path"; readonly path: string }
    | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  readonly capture?: typeof ScreenshotCaptureSchema.Type
  readonly title: string
  readonly summary: string
  readonly mode: "normal" | "wide"
  readonly role: ArtifactRole
}

export interface CreateFileArtifactInput {
  readonly sessionId: string
  readonly producerRunId: string
  readonly operationKey: string
  readonly source:
    | { readonly kind: "path"; readonly path: string }
    | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly filename: string }
  readonly title: string
  readonly summary: string
  readonly mediaType: string
  readonly role: ArtifactRole
}

export interface ConversationArtifact {
  readonly manifest: ConversationArtifactManifest
  readonly bytes: Uint8Array
}

export class ConversationArtifactError extends Schema.TaggedError<ConversationArtifactError>()(
  "ConversationArtifactError",
  {
    reason: Schema.Literals([
      "invalid",
      "not_found",
      "conflict",
      "corrupt",
      "quota",
      "storage"
    ] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

const artifactError = (
  reason: ConversationArtifactError["reason"],
  message: string,
  cause?: unknown
): ConversationArtifactError =>
  new ConversationArtifactError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const filesystem = <A>(
  message: string,
  run: () => Promise<A>
): Effect.Effect<A, ConversationArtifactError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => artifactError("storage", message, cause)
  })

const artifactRef = (sessionId: string, toolCallId: string): string =>
  `viz-${sha256Hex(`${sessionId}:${toolCallId}`).slice(0, 32)}`

const fileArtifactRef = (sessionId: string, operationKey: string): string =>
  `file-${sha256Hex(`${sessionId}:${operationKey}`).slice(0, 32)}`

const sameFields = Schema.toEquivalence(
  ManifestSchema.mapFields(Struct.omit(["created_at", "producer_run_id", "role"]))
)
const matchesArtifact = (
  stored: ConversationArtifactManifest,
  replay: ConversationArtifactManifest
): boolean => sameFields(stored, replay) && artifactRole(stored) === artifactRole(replay)

const detectImage = (
  bytes: Uint8Array
): {
  readonly mediaType: string
  readonly filename: "image.png" | "image.jpg" | "image.gif" | "image.webp"
} | null => {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  )
    return { mediaType: "image/png", filename: "image.png" }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: "image/jpeg", filename: "image.jpg" }
  }
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii")
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { mediaType: "image/gif", filename: "image.gif" }
    }
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return { mediaType: "image/webp", filename: "image.webp" }
  return null
}

const decodeManifest = (
  value: unknown
): Effect.Effect<ConversationArtifactManifest, ConversationArtifactError> =>
  Schema.decodeUnknownEffect(ManifestSchema)(value).pipe(
    Effect.mapError((cause) => artifactError("corrupt", "Visualization manifest is invalid", cause))
  )

const readArtifactFile = (
  target: string,
  maxBytes: number
): Effect.Effect<Uint8Array, ConversationArtifactError> =>
  filesystem(
    "Visualization content could not be read",
    async () => (await readRegularFile(target, maxBytes)).bytes
  ).pipe(
    Effect.catch((failure) => {
      if (isErrnoCode(failure.cause, "ENOENT")) {
        return Effect.fail(artifactError("not_found", "Visualization was not found"))
      }
      if (failure.cause instanceof PrivateFileError && failure.cause.reason === "too_large") {
        return Effect.fail(
          artifactError("quota", "Visualization content exceeds its size limit", failure.cause)
        )
      }
      return Effect.fail(failure)
    })
  )

const writeArtifact = Effect.fn("ConversationArtifacts.writeArtifact")(function* (
  root: string,
  manifest: ConversationArtifactManifest,
  bytes: Uint8Array
) {
  const ownerDirectory = join(root, manifest.ref)
  const temporary = join(root, `.artifact-${randomUUID()}.tmp`)
  yield* filesystem("Visualization directory could not be created", () =>
    mkdir(root, { recursive: true, mode: 0o700 })
  )
  return yield* Effect.gen(function* () {
    yield* filesystem("Visualization could not be staged", async () => {
      await mkdir(temporary, { mode: 0o700 })
      await writeNewFile(join(temporary, manifest.filename), bytes)
      await writeNewFile(join(temporary, "manifest.json"), JSON.stringify(manifest))
    })
    const existing = yield* readArtifactFile(join(ownerDirectory, "manifest.json"), 16 * 1024).pipe(
      Effect.catch((failure) =>
        failure.reason === "not_found" ? Effect.succeed(null) : Effect.fail(failure)
      )
    )
    if (existing !== null) {
      const previous = yield* Effect.try({
        try: () =>
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(existing)) as unknown,
        catch: (cause) =>
          artifactError("corrupt", "Visualization manifest is not valid UTF-8 JSON", cause)
      }).pipe(Effect.flatMap(decodeManifest))
      if (!matchesArtifact(previous, manifest)) {
        return yield* artifactError(
          "conflict",
          "Visualization call was replayed with different content or metadata"
        )
      }
      return previous
    }
    yield* filesystem("Visualization could not be committed", () =>
      rename(temporary, ownerDirectory)
    )
    return manifest
  }).pipe(
    Effect.ensuring(
      filesystem("Visualization staging directory could not be removed", () =>
        rm(temporary, { recursive: true, force: true })
      ).pipe(Effect.ignore)
    )
  )
})

const REMOVED_PREFIX = ".artifact-removed-"

const sweepRemoved = (folder: string): Effect.Effect<number> =>
  Effect.promise(async () => {
    const names = await readdir(folder).catch(() => [])
    const left = await Promise.all(
      names
        .filter((name) => name.startsWith(REMOVED_PREFIX))
        .map((name) =>
          rm(join(folder, name), { recursive: true, force: true, maxRetries: 2 }).then(
            () => 0,
            () => 1
          )
        )
    )
    return left.reduce((sum: number, one: number) => sum + one, 0)
  })

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
      try: () =>
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown,
      catch: (cause) =>
        artifactError("corrupt", "Visualization manifest is not valid UTF-8 JSON", cause)
    }).pipe(Effect.flatMap(decodeManifest))
    if (manifest.ref !== artifact) {
      return yield* artifactError("corrupt", "Visualization manifest does not match its reference")
    }
    const expectedHtml =
      manifest.kind === "html" &&
      manifest.filename === "content.html" &&
      manifest.media_type === "text/html; charset=utf-8"
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
