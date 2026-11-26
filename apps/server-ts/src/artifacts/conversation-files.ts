import { parseJsonText } from "@arden-hq/protocol/common"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema, Struct } from "effect"

import {
  isErrnoCode,
  PRIVATE_FILE_VIOLATION,
  PrivateFileError,
  readRegularFile,
  writeNewFile
} from "../fs/private-store.js"
import { ERRNO } from "@arden-hq/std/errors"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  ManifestSchema,
  type ConversationArtifactManifest,
  artifactRole,
  CONVERSATION_ERROR_REASON,
  ConversationArtifactError
} from "./conversation-model.js"

export const artifactError = (
  reason: ConversationArtifactError["reason"],
  message: string,
  cause?: unknown
): ConversationArtifactError =>
  new ConversationArtifactError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const filesystem = <A>(
  message: string,
  run: () => Promise<A>
): Effect.Effect<A, ConversationArtifactError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => artifactError("storage", message, cause)
  })

export const artifactRef = (sessionId: string, toolCallId: string): string =>
  `viz-${sha256Hex(`${sessionId}:${toolCallId}`).slice(0, 32)}`

export const fileArtifactRef = (sessionId: string, operationKey: string): string =>
  `file-${sha256Hex(`${sessionId}:${operationKey}`).slice(0, 32)}`

const sameFields = Schema.toEquivalence(
  ManifestSchema.mapFields(Struct.omit(["created_at", "producer_run_id", "role"]))
)
const matchesArtifact = (
  stored: ConversationArtifactManifest,
  replay: ConversationArtifactManifest
): boolean => sameFields(stored, replay) && artifactRole(stored) === artifactRole(replay)

const IMAGE_SIGNATURE = { gif87: "GIF87a", gif89: "GIF89a", riff: "RIFF", webp: "WEBP" } as const
type GifSignature = typeof IMAGE_SIGNATURE.gif87 | typeof IMAGE_SIGNATURE.gif89
const isGifSignature = (signature: string): signature is GifSignature =>
  signature === IMAGE_SIGNATURE.gif87 || signature === IMAGE_SIGNATURE.gif89

export const detectImage = (
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
    if (isGifSignature(signature)) {
      return { mediaType: "image/gif", filename: "image.gif" }
    }
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === IMAGE_SIGNATURE.riff &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === IMAGE_SIGNATURE.webp
  )
    return { mediaType: "image/webp", filename: "image.webp" }
  return null
}

export const decodeManifest = (
  value: unknown
): Effect.Effect<ConversationArtifactManifest, ConversationArtifactError> =>
  Schema.decodeUnknownEffect(ManifestSchema)(value).pipe(
    Effect.mapError((cause) => artifactError("corrupt", "Visualization manifest is invalid", cause))
  )

export const readArtifactFile = (
  target: string,
  maxBytes: number
): Effect.Effect<Uint8Array, ConversationArtifactError> =>
  filesystem(
    "Visualization content could not be read",
    async () => (await readRegularFile(target, maxBytes)).bytes
  ).pipe(
    Effect.catch((failure) => {
      if (isErrnoCode(failure.cause, ERRNO.ENOENT)) {
        return Effect.fail(artifactError("not_found", "Visualization was not found"))
      }
      if (
        failure.cause instanceof PrivateFileError &&
        failure.cause.reason === PRIVATE_FILE_VIOLATION.tooLarge
      ) {
        return Effect.fail(
          artifactError("quota", "Visualization content exceeds its size limit", failure.cause)
        )
      }
      return Effect.fail(failure)
    })
  )

export const writeArtifact = Effect.fn("ConversationArtifacts.writeArtifact")(function* (
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
        failure.reason === CONVERSATION_ERROR_REASON.notFound
          ? Effect.succeed(null)
          : Effect.fail(failure)
      )
    )
    if (existing !== null) {
      const previous = yield* Effect.try({
        try: () => parseJsonText(new TextDecoder("utf-8", { fatal: true }).decode(existing)),
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

export const REMOVED_PREFIX = ".artifact-removed-"

export const sweepRemoved = (folder: string): Effect.Effect<number> =>
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
