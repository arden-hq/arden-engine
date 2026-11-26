import { formatBytes } from "@arden-hq/std/count"
import path from "node:path"
import { Effect } from "effect"

import { writeAtomic } from "@arden-hq/std/atomic-file"
import { isErrnoCode } from "../fs/private-store.js"

import { type ResearchSourceSnapshot, type ResearchState } from "./model.js"
import {
  readPlainFile,
  researchError,
  storage,
  type ResearchWorkspaceError
} from "./workspace-storage.js"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  MAX_SOURCE_BYTES,
  MAX_TOTAL_SOURCE_BYTES,
  MAX_SOURCES,
  type SourceCaptureInput,
  canonicalResearchText,
  type WorkspacePaths,
  type ResearchMutationReceipt
} from "./workspace-model.js"
import { type WorkspaceState } from "./workspace-state.js"

export interface WorkspaceSources {
  readonly captureSource: (
    input: SourceCaptureInput
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
  readonly readSource: (
    workspaceId: string,
    paths: WorkspacePaths,
    snapshot: ResearchState["sources"][number]
  ) => Effect.Effect<string, ResearchWorkspaceError>
}

export const makeWorkspaceSources = ({
  mutate
}: {
  readonly mutate: WorkspaceState["mutate"]
}): WorkspaceSources => {
  const persistSource = Effect.fn("ResearchWorkspace.persistSource")(function* (
    workspaceId: string,
    paths: WorkspacePaths,
    bytes: Buffer
  ) {
    const rawHash = sha256Hex(bytes)
    const target = path.join(paths.sources, rawHash)
    const existing = yield* readPlainFile(
      workspaceId,
      target,
      "Research source could not be read",
      MAX_SOURCE_BYTES
    ).pipe(
      Effect.catch((failure) =>
        isErrnoCode(failure.cause, "ENOENT") ? Effect.succeed(null) : Effect.fail(failure)
      )
    )
    if (existing !== null) {
      if (sha256Hex(existing.bytes) !== rawHash) {
        return yield* researchError("corrupt", "Research source hash path is invalid", workspaceId)
      }
      return { rawHash, bytes: bytes.byteLength }
    }

    yield* storage(workspaceId, "Research source could not be stored", () =>
      writeAtomic(target, bytes)
    )
    return { rawHash, bytes: bytes.byteLength }
  })

  const captureSource = Effect.fn("ResearchWorkspace.captureSource")((
    input: SourceCaptureInput
  ) => {
    const normalized = canonicalResearchText(input.text)
    return mutate({
      workspaceId: input.workspaceId,
      expectedRevision: null,
      operationId: input.operationId,
      payload: {
        locator: input.locator,
        title: input.title,
        text: input.text,
        publishedAt: input.publishedAt
      },
      apply: Effect.fn("ResearchWorkspace.captureSource.apply")(
        function* (state, paths, timestamp, nextRevision) {
          if (input.locator.length === 0 || input.locator.length > 8_000) {
            return yield* researchError(
              "invalid",
              "Research source locator is invalid",
              input.workspaceId
            )
          }
          if (input.title.length > 2_000) {
            return yield* researchError(
              "invalid",
              "Research source title is too long",
              input.workspaceId
            )
          }
          if (input.publishedAt !== null && input.publishedAt.length > 128) {
            return yield* researchError(
              "invalid",
              "Research source publication date is too long",
              input.workspaceId
            )
          }
          if (state.sources.length >= MAX_SOURCES) {
            return yield* researchError("quota", "Research source limit reached", input.workspaceId)
          }
          const candidateBytes = Buffer.from(input.text, "utf8")
          if (candidateBytes.byteLength > MAX_SOURCE_BYTES) {
            return yield* researchError(
              "quota",
              `One research source may be at most ${formatBytes(MAX_SOURCE_BYTES)}`,
              input.workspaceId
            )
          }
          const sourceBytes = new Map(state.sources.map((source) => [source.rawHash, source.bytes]))
          sourceBytes.set(sha256Hex(candidateBytes), candidateBytes.byteLength)
          const totalBytes = [...sourceBytes.values()].reduce((total, bytes) => total + bytes, 0)
          if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
            return yield* researchError(
              "quota",
              `Research source storage exceeds ${formatBytes(MAX_TOTAL_SOURCE_BYTES)}`,
              input.workspaceId
            )
          }
          const persisted = yield* persistSource(input.workspaceId, paths, candidateBytes)
          const snapshotRef = `source-${sha256Hex(input.operationId).slice(0, 32)}`
          const snapshot = {
            snapshotRef,
            locator: input.locator,
            title: input.title,
            rawHash: persisted.rawHash,
            canonicalHash: sha256Hex(normalized),
            renderer: "plain-text-v1" as const,
            retrievedAt: timestamp,
            publishedAt: input.publishedAt,
            bytes: persisted.bytes,
            characters: normalized.length
          } satisfies ResearchSourceSnapshot
          return {
            state: { ...state, sources: [...state.sources, snapshot] },
            result: { snapshot_ref: snapshotRef, revision: nextRevision }
          }
        }
      )
    })
  })

  const readSource = Effect.fn("ResearchWorkspace.readSource")(function* (
    workspaceId: string,
    paths: WorkspacePaths,
    snapshot: ResearchSourceSnapshot
  ) {
    const target = path.join(paths.sources, snapshot.rawHash)
    const file = yield* readPlainFile(
      workspaceId,
      target,
      "Research source could not be read",
      MAX_SOURCE_BYTES
    )
    if (file.size !== snapshot.bytes) {
      return yield* researchError("corrupt", "Research source snapshot is invalid", workspaceId)
    }
    if (sha256Hex(file.bytes) !== snapshot.rawHash) {
      return yield* researchError("corrupt", "Research source hash does not match", workspaceId)
    }
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    } catch (cause) {
      return yield* researchError(
        "corrupt",
        "Research source is not valid UTF-8",
        workspaceId,
        cause
      )
    }
    const canonical = canonicalResearchText(text)
    if (sha256Hex(canonical) !== snapshot.canonicalHash) {
      return yield* researchError(
        "corrupt",
        "Research canonical source hash does not match",
        workspaceId
      )
    }
    return canonical
  })
  return { captureSource, readSource }
}
