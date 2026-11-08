import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Cause, Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"

import { ConversationArtifacts } from "../artifacts/conversation.js"
import { ManagedOutputLifecycleStore } from "../persistence/managed-output/lifecycle-store.js"
import { ManagedOutputs } from "../artifacts/managed-output/managed-output.js"
import { isUploadId } from "../persistence/sessions/chat-uploads.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"

export class SessionFileCleanupError extends Schema.TaggedError<SessionFileCleanupError>()(
  "SessionFileCleanupError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SessionFileCleanupError({ message, cause })
  })

interface UploadFolder {
  readonly remove: (uploadId: string) => Promise<void>
  readonly olderThan: (cutoffMs: number) => Promise<ReadonlyArray<string>>
}

const uploadFolder = (root: string): UploadFolder => ({
  remove: async (uploadId) => {
    if (!isUploadId(uploadId)) throw new Error("Not an upload id")
    await rm(join(root, uploadId), { recursive: true, force: true })
  },
  olderThan: async (cutoffMs) => {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    })
    const old: Array<string> = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUploadId(entry.name)) continue
      const info = await stat(join(root, entry.name)).catch(() => undefined)
      if (info !== undefined && info.mtimeMs < cutoffMs) old.push(entry.name)
    }
    return old
  }
})

const UNSENT_UPLOAD_AGE_MS = 7 * 24 * 60 * 60 * 1000

const DRAIN_EVERY = "6 hours"

const makeSessionFileCleanup = Effect.fn("SessionFileCleanup.make")(function* (
  lifecycle: Pick<
    ManagedOutputLifecycleStore["Service"],
    | "pendingCleanup"
    | "cleanupSession"
    | "pendingGc"
    | "completeGc"
    | "pendingUploads"
    | "queueUploads"
    | "decideUpload"
    | "finishUpload"
    | "deferUpload"
  >,
  outputs: Pick<ManagedOutputs["Service"], "ownerDigests" | "removeOwner" | "collectDigest">,
  artifacts: Pick<ConversationArtifacts["Service"], "remove">,
  uploads: UploadFolder
) {
  const lock = yield* Semaphore.make(1)
  const drainGc = Effect.fn("SessionFileCleanup.drainGc")(function* () {
    for (;;) {
      const pending = yield* attempt("Could not list unreferenced Session files", () =>
        lifecycle.pendingGc()
      )
      if (pending.length === 0) return
      for (const candidate of pending) {
        yield* attempt(
          `Could not collect an unreferenced file of Session ${candidate.sessionId}`,
          () =>
            lifecycle.completeGc(candidate.sessionId, candidate.digest, async () => {
              await outputs.collectDigest(candidate.digest)
            })
        )
      }
    }
  })
  const drainUploads = Effect.fn("SessionFileCleanup.drainUploads")(function* () {
    for (;;) {
      const pending = yield* attempt("Could not list uploads to clean up", () =>
        lifecycle.pendingUploads()
      )
      if (pending.length === 0) return
      for (const uploadId of pending) {
        const decision = yield* attempt(`Could not check upload ${uploadId}`, () =>
          lifecycle.decideUpload(uploadId)
        )
        if (decision === "wait") return
        if (decision !== "remove") continue
        const failure = yield* Effect.promise(() =>
          uploads.remove(uploadId).then(
            () => undefined,
            (error: unknown) => ({ error })
          )
        )
        if (failure === undefined) {
          yield* attempt(`Could not finish removing upload ${uploadId}`, () =>
            lifecycle.finishUpload(uploadId)
          )
          continue
        }
        const retried = yield* attempt(`Could not defer upload ${uploadId}`, () =>
          lifecycle.deferUpload(uploadId)
        )
        yield* Effect.logWarning("Could not remove an upload folder", {
          uploadId,
          retried,
          error: failure.error
        })
      }
    }
  })
  const queueUnsentUploads = Effect.fn("SessionFileCleanup.queueUnsentUploads")(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - UNSENT_UPLOAD_AGE_MS
    const old = yield* attempt("Could not list old uploads", () => uploads.olderThan(cutoff))
    if (old.length > 0)
      yield* attempt("Could not queue old uploads", () => lifecycle.queueUploads(old))
  })
  const cleanupOne = Effect.fn("SessionFileCleanup.cleanupOne")(function* (sessionId: string) {
    const completed = yield* attempt(`Could not clean up files of Session ${sessionId}`, () =>
      lifecycle.cleanupSession({
        sessionId,
        ownerDigests: () => outputs.ownerDigests(sessionId),
        remove: async () => {
          await Effect.runPromise(artifacts.remove(sessionId))
          await outputs.removeOwner(sessionId)
        }
      })
    )
    if (completed) {
      yield* drainGc()
      yield* drainUploads()
    }
    return completed
  })
  const drainAll = Effect.fn("SessionFileCleanup.drain")(function* () {
    let completed = 0
    for (;;) {
      const pending = yield* attempt("Could not list pending Session cleanups", () =>
        lifecycle.pendingCleanup()
      )
      if (pending.length === 0) break
      for (const sessionId of pending) {
        if (yield* cleanupOne(sessionId)) completed += 1
      }
    }
    yield* drainGc()
    yield* queueUnsentUploads()
    yield* drainUploads()
    return completed
  })
  const drain = () => lock.withPermit(drainAll())
  const drainAfterDelete = () =>
    drain().pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning("Could not clean deleted Session files", error))
    )
  return SessionFileCleanup.of({ drain, drainAfterDelete })
})

export class SessionFileCleanup extends Context.Service<
  SessionFileCleanup,
  {
    readonly drain: () => Effect.Effect<number, SessionFileCleanupError>
    readonly drainAfterDelete: () => Effect.Effect<void>
  }
>()("@arden-hq/server/storage/SessionFileCleanup") {
  static readonly layer = (
    uploadsRoot: string
  ): Layer.Layer<
    SessionFileCleanup,
    never,
    ManagedOutputLifecycleStore | ManagedOutputs | ConversationArtifacts
  > =>
    Layer.effect(
      SessionFileCleanup,
      Effect.gen(function* () {
        const lifecycle = yield* ManagedOutputLifecycleStore
        const server = yield* ServerLifecycle
        const outputs = yield* ManagedOutputs
        const artifacts = yield* ConversationArtifacts
        const cleanup = yield* makeSessionFileCleanup(
          lifecycle,
          outputs,
          artifacts,
          uploadFolder(uploadsRoot)
        )
        yield* server.background(
          cleanup.drain().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not drain deleted Session files", {
                error: Cause.squash(cause)
              })
            ),
            Effect.andThen(Effect.sleep(DRAIN_EVERY)),
            Effect.forever
          )
        )
        return cleanup
      })
    )
}
