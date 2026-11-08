import type { ToolContext } from "@arden-hq/loop"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { formatBytes } from "@arden-hq/std/count"
import { sha256Hex } from "@arden-hq/std/hash"
import { Effect, Option, Schema } from "effect"
import { basename, join } from "node:path"

import { ConversationArtifactError, ConversationArtifacts } from "../artifacts/conversation.js"
import {
  ManagedOutputs,
  type ManagedOutputWriter
} from "../artifacts/managed-output/managed-output.js"
import { sharedResourceSessions } from "../execution/authority.js"
import { PrivateFileError, readRegularFile } from "../fs/private-store.js"
import { JsonObjectSchema, type JsonObject } from "../persistence/json.js"
import { managedObjectRefParts } from "../persistence/managed-output/descriptor.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { DataRoot } from "../runtime/data-root.js"
import { neverRuleRefusal, pathRuleFor, type LocalPathServices } from "../storage/local-paths.js"
import { cwdFor, filesystemError } from "./file-tool-support.js"
import {
  fileMediaType,
  safeAttachmentName,
  transcriptFiles,
  type TranscriptFile
} from "./shared-file-sources.js"
import { checkUploadPath, uploadRefusalText } from "./shared-file-policy.js"
import type { ServerRunContext } from "./run-context.js"
import { toolFailure, toolRefusal } from "./tool-failure.js"

const SHARED_FILE_MAX_BYTES = 100 * 1024 * 1024

export const FileRefSchema = Schema.Union([
  Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description: "A local file path, or a managed-output reference returned by a tool."
    })
  }),
  Schema.Struct({
    artifact_ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: "Exact artifact_ref returned by chat_files_list or a file-producing tool."
    })
  }),
  Schema.Struct({
    attachment: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).annotate({
      description: "Image attachment number from chat_files_list, numbered through the full chat."
    })
  })
])
export type FileRef = typeof FileRefSchema.Type

const PreparedFields = {
  session_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  size: Schema.Natural,
  media_type: Schema.NonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  source: FileRefSchema
}
export const PreparedFileSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    artifact_ref: Schema.NonEmptyString,
    ...PreparedFields
  }),
  Schema.Struct({ kind: Schema.Literal("outside"), path: Schema.NonEmptyString, ...PreparedFields })
])
export type PreparedFile = typeof PreparedFileSchema.Type

export interface SharedFileServices extends LocalPathServices {
  readonly artifacts: ConversationArtifacts["Service"]
  readonly outputs: ManagedOutputWriter
  readonly transcript: TranscriptQueries["Service"]
  readonly stateRoots: ReadonlyArray<string>
}
export type SharedFileContext = Pick<
  ToolContext<ServerRunContext>,
  "run" | "signal" | "toolCallId" | "approval"
>
export interface ResolvedFile {
  readonly filename: string
  readonly mimeType: string
  readonly bytes: Buffer
}

const prepareFiles = async ({
  services,
  ctx,
  refs,
  key,
  maxBytes = SHARED_FILE_MAX_BYTES,
  allowOutside = false
}: {
  readonly services: SharedFileServices
  readonly ctx: SharedFileContext
  readonly refs: ReadonlyArray<FileRef>
  readonly key: string
  readonly maxBytes?: number
  readonly allowOutside?: boolean
}): Promise<ReadonlyArray<PreparedFile>> => {
  if (refs.length === 0) return []
  const owners = await fileOwnerSessions(services, ctx)
  const policy = await cwdFor(services, ctx)
  const roots = {
    folders: policy.usableRoots,
    artifacts: await Promise.all(
      owners.map((owner) =>
        Effect.runPromise(services.artifacts.rootPath(owner), { signal: ctx.signal })
      )
    ),
    stateRoots: services.stateRoots,
    userUploadRoots: [join(services.dataDir, "uploads")],
    attachedPaths: (await transcriptFiles(services.transcript, owners, ctx.signal)).flatMap(
      (file) => (file.kind === "path" ? [file.path] : [])
    )
  }
  const prepared: PreparedFile[] = []
  let remaining = Math.min(maxBytes, SHARED_FILE_MAX_BYTES)
  for (const [index, ref] of refs.entries()) {
    ctx.signal.throwIfAborted()
    if ("artifact_ref" in ref) {
      const artifact = await ownedArtifact(services, ctx, owners, ref.artifact_ref)
      enforceSize(artifact.bytes.byteLength, remaining, artifact.manifest.filename)
      prepared.push({
        kind: "snapshot",
        artifact_ref: artifact.manifest.ref,
        session_id: artifact.owner,
        name: artifact.manifest.filename,
        size: artifact.bytes.byteLength,
        media_type: artifact.manifest.media_type,
        sha256: artifact.manifest.sha256,
        source: ref
      })
      remaining -= artifact.bytes.byteLength
      continue
    }
    const source = await sourceFile(services, ctx, owners, ref, remaining)
    if (source.kind === "path") {
      const check = await checkUploadPath({ path: source.path, roots })
      if (check.kind === "refused")
        throw toolRefusal(uploadRefusalText(check.reason), "File unavailable")
      if (pathRuleFor(policy, { lexical: source.path, real: check.path }, "read") === "never")
        throw neverRuleRefusal(check.path, "read")
      if (check.kind === "outside" && !allowOutside) {
        throw toolRefusal(
          `${check.name} is outside the folders a rule lets Arden use. Ask the user for a folder rule, or to attach the file in chat, then retry.`,
          "File access required"
        )
      }
      const bytes = await boundedFile(check.path, remaining)
      if (check.kind === "outside") {
        prepared.push({
          kind: "outside",
          path: check.path,
          session_id: ctx.run.sessionId,
          name: check.name,
          size: bytes.byteLength,
          media_type: fileMediaType(bytes, check.name),
          sha256: sha256Hex(bytes),
          source: ref
        })
      } else {
        prepared.push(
          await publishSnapshot({
            services,
            ctx,
            source: ref,
            key: `file-transfer:${key}:${index}`,
            name: check.name,
            bytes
          })
        )
      }
      remaining -= bytes.byteLength
      continue
    }
    enforceSize(source.bytes.byteLength, remaining, source.name)
    prepared.push(
      await publishSnapshot({
        services,
        ctx,
        source: ref,
        key: `file-transfer:${key}:${index}`,
        name: source.name,
        bytes: source.bytes
      })
    )
    remaining -= source.bytes.byteLength
  }
  return prepared
}

const readPreparedFiles = async ({
  services,
  ctx,
  files,
  maxBytes = SHARED_FILE_MAX_BYTES
}: {
  readonly services: SharedFileServices
  readonly ctx: SharedFileContext
  readonly files: ReadonlyArray<PreparedFile>
  readonly maxBytes?: number
}): Promise<ReadonlyArray<ResolvedFile>> => {
  if (files.length === 0) return []
  const owners = await fileOwnerSessions(services, ctx)
  const result: ResolvedFile[] = []
  let remaining = Math.min(maxBytes, SHARED_FILE_MAX_BYTES)
  for (const file of files) {
    if (!owners.includes(file.session_id))
      throw toolRefusal("The approved file belongs to another chat.", "File access denied")
    enforceSize(file.size, remaining, file.name)
    if (file.kind === "outside" && ctx.approval === undefined) {
      throw toolRefusal(
        "This file can be uploaded only after its card is approved.",
        "File approval required"
      )
    }
    const bytes =
      file.kind === "outside"
        ? await boundedFile(file.path, remaining)
        : Buffer.from(
            (
              await Effect.runPromise(
                services.artifacts
                  .read(file.session_id, file.artifact_ref)
                  .pipe(
                    Effect.mapError((cause) => toolFailure(cause, "Approved file unavailable"))
                  ),
                { signal: ctx.signal }
              )
            ).bytes
          )
    if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) {
      throw toolRefusal(
        `${file.name} changed after approval. Nothing was uploaded; request a fresh approval.`,
        "File changed"
      )
    }
    result.push({ filename: file.name, mimeType: file.media_type, bytes })
    remaining -= bytes.byteLength
  }
  return result
}

const FilesApprovalSchema = Schema.Struct({
  version: Schema.Literal(1),
  key: Schema.NonEmptyString,
  refs: Schema.Array(FileRefSchema),
  files: Schema.Array(PreparedFileSchema),
  intent: Schema.optionalKey(JsonObjectSchema)
})

export const preparedFilesApproval = ({
  key,
  refs,
  files,
  intent
}: {
  readonly key: string
  readonly refs: ReadonlyArray<FileRef>
  readonly files: ReadonlyArray<PreparedFile>
  readonly intent?: JsonObject
}): JsonObject => ({ version: 1, key, refs, files, ...(intent === undefined ? {} : { intent }) })

const filesForExecution = async ({
  services,
  ctx,
  refs,
  key,
  intent,
  maxBytes
}: {
  readonly services: SharedFileServices
  readonly ctx: SharedFileContext
  readonly refs: ReadonlyArray<FileRef>
  readonly key: string
  readonly intent?: JsonObject
  readonly maxBytes?: number
}): Promise<ReadonlyArray<ResolvedFile>> => {
  if (ctx.approval === undefined) {
    return readPreparedFiles({
      services,
      ctx,
      files: await prepareFiles({
        services,
        ctx,
        refs,
        key,
        ...(maxBytes === undefined ? {} : { maxBytes })
      }),
      ...(maxBytes === undefined ? {} : { maxBytes })
    })
  }
  const parsed = Schema.decodeUnknownOption(FilesApprovalSchema)(
    ctx.approval.data?.["shared_files"]
  )
  if (Option.isNone(parsed)) {
    if (refs.length === 0) return []
    throw toolRefusal(
      "The approval does not identify the files to send. Request a fresh approval.",
      "File approval changed"
    )
  }
  const approved = parsed.value
  if (
    approved.key !== key ||
    !Schema.toEquivalence(Schema.Array(FileRefSchema))(approved.refs, refs) ||
    (approved.intent === undefined) !== (intent === undefined) ||
    !Schema.toEquivalence(JsonObjectSchema)(approved.intent ?? {}, intent ?? {})
  ) {
    throw toolRefusal(
      "The files or destination changed after approval. Request a fresh approval.",
      "File approval changed"
    )
  }
  return readPreparedFiles({
    services,
    ctx,
    files: approved.files,
    ...(maxBytes === undefined ? {} : { maxBytes })
  })
}

export const fileOwnerSessions = async (
  services: SharedFileServices,
  ctx: SharedFileContext
): Promise<ReadonlyArray<string>> => {
  const lineage =
    ctx.run.authority.actor.kind === "agent"
      ? await Effect.runPromise(sessionLineage(services.sessions, ctx.run.sessionId), {
          signal: ctx.signal
        })
      : []
  const root = lineage.at(-1)?.sessionId
  return [
    ...new Set([
      ctx.run.sessionId,
      ...(root === undefined ? [] : [root]),
      ...sharedResourceSessions(ctx.run.authority, "agent_code").map(
        (resource) => resource.session_id
      )
    ])
  ]
}

const ownedArtifact = async (
  services: SharedFileServices,
  ctx: SharedFileContext,
  owners: ReadonlyArray<string>,
  ref: string
) => {
  for (const owner of owners) {
    try {
      return {
        ...(await Effect.runPromise(services.artifacts.read(owner, ref), { signal: ctx.signal })),
        owner
      }
    } catch (cause) {
      if (!(cause instanceof ConversationArtifactError)) throw filesystemError(cause, "read", ref)
      if (cause.reason !== "not_found") throw toolFailure(cause, "File unavailable")
    }
  }
  throw toolRefusal(
    "That file is not available in this chat or a granted shared chat.",
    "File unavailable"
  )
}

const sourceFile = async (
  services: SharedFileServices,
  ctx: SharedFileContext,
  owners: ReadonlyArray<string>,
  ref: Exclude<FileRef, { readonly artifact_ref: string }>,
  maxBytes: number
): Promise<
  | Extract<TranscriptFile, { readonly kind: "path" }>
  | { readonly kind: "bytes"; readonly name: string; readonly bytes: Buffer }
> => {
  if ("attachment" in ref) {
    const file = (
      await transcriptFiles(services.transcript, [ctx.run.sessionId], ctx.signal)
    ).filter((entry) => entry.kind === "image")[ref.attachment - 1]
    if (file?.kind !== "image")
      throw toolRefusal(
        "There is no attached image with that number. Use chat_files_list to find its file reference.",
        "Attachment unavailable"
      )
    enforceSize(Math.floor((file.data.length * 3) / 4), maxBytes + 2, file.name)
    return { kind: "bytes", name: file.name, bytes: Buffer.from(file.data, "base64") }
  }
  const managed = managedObjectRefParts(ref.path)
  if (managed !== undefined) {
    const text = await services.outputs
      .read({ sessionId: ctx.run.sessionId, ref: ref.path })
      .catch((cause: unknown) => {
        throw filesystemError(cause, "read", ref.path)
      })
    return {
      kind: "bytes",
      name: `arden-output.${managed.format === "json" ? "json" : "txt"}`,
      bytes: Buffer.from(text, "utf8")
    }
  }
  return {
    kind: "path",
    path: ref.path,
    name: basename(ref.path),
    sessionId: owners[0] ?? ctx.run.sessionId,
    key: ref.path
  }
}

const publishSnapshot = async ({
  services,
  ctx,
  source,
  key,
  name,
  bytes,
  mediaType
}: {
  readonly services: SharedFileServices
  readonly ctx: SharedFileContext
  readonly source?: FileRef
  readonly key: string
  readonly name: string
  readonly bytes: Buffer
  readonly mediaType?: string
}): Promise<PreparedFile> => {
  enforceSize(bytes.byteLength, SHARED_FILE_MAX_BYTES, name)
  const filename = safeAttachmentName(name, "attachment")
  const manifest = await Effect.runPromise(
    services.artifacts
      .createFile({
        sessionId: ctx.run.sessionId,
        producerRunId: ctx.run.runId,
        operationKey: key,
        source: { kind: "bytes", bytes, filename },
        title: filename,
        summary: "Reusable file",
        mediaType: mediaType ?? fileMediaType(bytes, name),
        role: "working"
      })
      .pipe(Effect.mapError((cause) => toolFailure(cause, "File could not be prepared"))),
    { signal: ctx.signal }
  )
  return {
    kind: "snapshot",
    artifact_ref: manifest.ref,
    session_id: ctx.run.sessionId,
    name: manifest.filename,
    size: manifest.byte_length,
    media_type: manifest.media_type,
    sha256: manifest.sha256,
    source: source ?? { artifact_ref: manifest.ref }
  }
}

const boundedFile = async (path: string, maxBytes: number): Promise<Buffer> => {
  try {
    return (await readRegularFile(path, maxBytes)).bytes
  } catch (cause) {
    if (cause instanceof PrivateFileError && cause.reason === "too_large") {
      throw toolRefusal(
        `${basename(path)} exceeds the remaining file limit of ${formatBytes(maxBytes)}. Choose fewer or smaller files.`,
        "Files too large"
      )
    }
    throw filesystemError(cause, "read", path)
  }
}

const enforceSize = (size: number, maximum: number, name: string): void => {
  if (size > maximum)
    throw toolRefusal(
      `${name} exceeds the remaining file limit of ${formatBytes(maximum)}. Choose fewer or smaller files.`,
      "Files too large"
    )
}

export interface SharedFileAccess {
  readonly prepare: (
    input: Omit<Parameters<typeof prepareFiles>[0], "services">
  ) => ReturnType<typeof prepareFiles>
  readonly read: (
    input: Omit<Parameters<typeof readPreparedFiles>[0], "services">
  ) => ReturnType<typeof readPreparedFiles>
  readonly forExecution: (
    input: Omit<Parameters<typeof filesForExecution>[0], "services">
  ) => ReturnType<typeof filesForExecution>
  readonly publish: (input: {
    readonly ctx: SharedFileContext
    readonly key: string
    readonly name: string
    readonly bytes: Buffer
    readonly mediaType?: string
  }) => Promise<PreparedFile>
}

export const createSharedFileAccess = (services: SharedFileServices): SharedFileAccess => ({
  prepare: (input) => prepareFiles({ services, ...input }),
  read: (input) => readPreparedFiles({ services, ...input }),
  forExecution: (input) => filesForExecution({ services, ...input }),
  publish: (input) => publishSnapshot({ services, ...input })
})

export const sharedFileServices = Effect.gen(function* () {
  const root = yield* DataRoot
  return {
    artifacts: yield* ConversationArtifacts,
    outputs: yield* ManagedOutputs,
    transcript: yield* TranscriptQueries,
    sessions: yield* SessionQueries,
    spaces: yield* SpaceStore,
    runs: yield* RunQueries,
    rules: yield* PermissionRules,
    dataDir: root.dir,
    stateRoots: [root.dir]
  } satisfies SharedFileServices
})
