import { parseJsonText } from "@arden-hq/protocol/common"
import { formatBytes } from "@arden-hq/std/count"
import path from "node:path"
import { DateTime, Effect, Schema, Semaphore } from "effect"

import { writeAtomic } from "@arden-hq/std/atomic-file"
import { isErrnoCode } from "../fs/private-store.js"

import { emptyResearchState, type ResearchState } from "./model.js"
import {
  decodeState,
  ensureDirectory,
  readPlainFile,
  researchError,
  storage,
  ResearchWorkspaceError
} from "./workspace-storage.js"
import {
  MAX_STATE_BYTES,
  MAX_OPERATIONS,
  WorkspaceIdSchema,
  OperationIdSchema,
  type ResearchMutationReceipt,
  operationPayloadHash,
  type WorkspacePaths
} from "./workspace-model.js"

interface LoadedState {
  readonly paths: WorkspacePaths
  readonly state: ResearchState
}

interface StateMutation<A extends Readonly<Record<string, Schema.Json>>> {
  readonly workspaceId: string
  readonly expectedRevision: number | null
  readonly operationId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly apply: (
    state: ResearchState,
    paths: WorkspacePaths,
    timestamp: string,
    nextRevision: number
  ) => Effect.Effect<{ readonly state: ResearchState; readonly result: A }, ResearchWorkspaceError>
}

export interface WorkspaceState {
  readonly paths: (workspaceId: string) => Effect.Effect<WorkspacePaths, ResearchWorkspaceError>
  readonly readState: (workspaceId: string) => Effect.Effect<LoadedState, ResearchWorkspaceError>
  readonly mutate: <A extends Readonly<Record<string, Schema.Json>>>(
    input: StateMutation<A>
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
}

export const makeWorkspaceState = (root: string): WorkspaceState => {
  const permits = new Map<string, Semaphore.Semaphore>()

  const validatedId = (workspaceId: string): Effect.Effect<string, ResearchWorkspaceError> =>
    Schema.decodeUnknownEffect(WorkspaceIdSchema)(workspaceId).pipe(
      Effect.mapError((cause) =>
        researchError("invalid", "Research workspace reference is invalid", workspaceId, cause)
      )
    )

  const paths = Effect.fn("ResearchWorkspace.paths")(function* (workspaceId: string) {
    const id = yield* validatedId(workspaceId)
    const directory = path.join(root, id)
    return {
      directory,
      state: path.join(directory, "state.json"),
      sources: path.join(directory, "sources")
    } satisfies WorkspacePaths
  })

  const prepare = Effect.fn("ResearchWorkspace.prepare")(function* (workspaceId: string) {
    const resolved = yield* paths(workspaceId)
    yield* ensureDirectory(root, workspaceId)
    yield* ensureDirectory(resolved.directory, workspaceId)
    yield* ensureDirectory(resolved.sources, workspaceId)
    return resolved
  })

  const readState = Effect.fn("ResearchWorkspace.readState")(function* (workspaceId: string) {
    const resolved = yield* prepare(workspaceId)
    const file = yield* readPlainFile(
      workspaceId,
      resolved.state,
      "Research state could not be read",
      MAX_STATE_BYTES
    ).pipe(
      Effect.catch((failure) =>
        isErrnoCode(failure.cause, "ENOENT") ? Effect.succeed(null) : Effect.fail(failure)
      )
    )
    if (file === null) return { paths: resolved, state: emptyResearchState() }
    const raw = yield* Effect.try({
      try: () => parseJsonText(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)),
      catch: (cause) =>
        researchError("corrupt", "Research state is not valid UTF-8 JSON", workspaceId, cause)
    })
    return { paths: resolved, state: yield* decodeState(workspaceId, raw) }
  })

  const writeState = Effect.fn("ResearchWorkspace.writeState")(function* (
    workspaceId: string,
    paths: WorkspacePaths,
    state: ResearchState
  ) {
    const encoded = Buffer.from(JSON.stringify(state), "utf8")
    if (encoded.byteLength > MAX_STATE_BYTES) {
      return yield* researchError(
        "quota",
        `Research state exceeds its ${formatBytes(MAX_STATE_BYTES)} limit`,
        workspaceId
      )
    }
    yield* storage(workspaceId, "Research state could not be committed", () =>
      writeAtomic(paths.state, encoded)
    )
  })

  const permitFor = (workspaceId: string): Semaphore.Semaphore => {
    const existing = permits.get(workspaceId)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    permits.set(workspaceId, created)
    return created
  }

  const mutate = <A extends Readonly<Record<string, Schema.Json>>>(input: {
    readonly workspaceId: string
    readonly expectedRevision: number | null
    readonly operationId: string
    readonly payload: Readonly<Record<string, unknown>>
    readonly apply: (
      state: ResearchState,
      paths: WorkspacePaths,
      timestamp: string,
      nextRevision: number
    ) => Effect.Effect<
      { readonly state: ResearchState; readonly result: A },
      ResearchWorkspaceError
    >
  }): Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError> =>
    permitFor(input.workspaceId).withPermit(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(OperationIdSchema)(input.operationId).pipe(
          Effect.mapError((cause) =>
            researchError("invalid", "Research operation id is invalid", input.workspaceId, cause)
          )
        )
        if (
          input.expectedRevision !== null &&
          (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        ) {
          return yield* researchError("invalid", "Research revision is invalid", input.workspaceId)
        }
        const loaded = yield* readState(input.workspaceId)
        const payloadHash = operationPayloadHash(input.payload)
        const prior = loaded.state.operations.find(
          (operation) => operation.operationId === input.operationId
        )
        if (prior !== undefined) {
          if (prior.payloadHash !== payloadHash) {
            return yield* researchError(
              "conflict",
              "The operation id was already used with a different payload",
              input.workspaceId
            )
          }
          return {
            revision: loaded.state.revision,
            changed: false,
            result: prior.result
          }
        }
        if (input.expectedRevision !== null && input.expectedRevision !== loaded.state.revision) {
          return yield* researchError(
            "conflict",
            `Research state is at revision ${loaded.state.revision}; review it and retry`,
            input.workspaceId
          )
        }
        if (loaded.state.operations.length >= MAX_OPERATIONS) {
          return yield* researchError(
            "quota",
            "Research operation history is full",
            input.workspaceId
          )
        }
        const timestamp = DateTime.formatIso(yield* DateTime.now)
        const nextRevision = loaded.state.revision + 1
        const applied = yield* input.apply(loaded.state, loaded.paths, timestamp, nextRevision)
        const next = {
          ...applied.state,
          revision: nextRevision,
          operations: [
            ...applied.state.operations,
            {
              operationId: input.operationId,
              payloadHash,
              result: applied.result,
              createdAt: timestamp
            }
          ]
        } satisfies ResearchState
        yield* decodeState(input.workspaceId, next)
        yield* writeState(input.workspaceId, loaded.paths, next)
        return { revision: nextRevision, changed: true, result: applied.result }
      })
    )
  return { paths, readState, mutate }
}
