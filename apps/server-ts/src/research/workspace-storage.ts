import { Effect, Schema } from "effect"
import { ensurePrivateDir, PrivateFileError, readRegularFile } from "../fs/private-store.js"
import { ResearchStateSchema, type ResearchState } from "./model.js"

export class ResearchWorkspaceError extends Schema.TaggedError<ResearchWorkspaceError>()(
  "ResearchWorkspaceError",
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
    workspaceId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const researchError = (
  reason: ResearchWorkspaceError["reason"],
  message: string,
  workspaceId?: string,
  cause?: unknown
): ResearchWorkspaceError =>
  new ResearchWorkspaceError({
    reason,
    message,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(cause === undefined ? {} : { cause })
  })

export const storage = <A>(
  workspaceId: string,
  message: string,
  run: () => Promise<A>
): Effect.Effect<A, ResearchWorkspaceError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => researchError("storage", message, workspaceId, cause)
  })

export const readPlainFile = (
  workspaceId: string,
  target: string,
  message: string,
  maxBytes: number
): Effect.Effect<
  {
    readonly bytes: Buffer
    readonly size: number
  },
  ResearchWorkspaceError
> =>
  storage(workspaceId, message, () => readRegularFile(target, maxBytes)).pipe(
    Effect.catch((failure) => {
      if (!(failure.cause instanceof PrivateFileError)) return Effect.fail(failure)
      switch (failure.cause.reason) {
        case "not_regular":
        case "not_directory":
          return Effect.fail(
            researchError("corrupt", "Research workspace contains an invalid file", workspaceId)
          )
        case "too_large":
          return Effect.fail(
            researchError("quota", "Research workspace file exceeds its size limit", workspaceId)
          )
      }
    })
  )

export const ensureDirectory = Effect.fn("ResearchWorkspace.ensureDirectory")(function* (
  directory: string,
  workspaceId: string
) {
  yield* storage(workspaceId, "Research workspace could not be created", () =>
    ensurePrivateDir(directory)
  ).pipe(
    Effect.catch((failure) =>
      failure.cause instanceof PrivateFileError
        ? Effect.fail(
            researchError("corrupt", "Research workspace directory is invalid", workspaceId)
          )
        : Effect.fail(failure)
    )
  )
})

export const decodeState = (
  workspaceId: string,
  value: unknown
): Effect.Effect<ResearchState, ResearchWorkspaceError> =>
  Schema.decodeUnknownEffect(ResearchStateSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) =>
      researchError(
        "corrupt",
        "Research state is invalid; restore or remove the workspace before continuing",
        workspaceId,
        cause
      )
    )
  )
