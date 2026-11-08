import { Deferred, Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as properLockfile from "proper-lockfile"

import { RevisionLockFactory, type RevisionLockFactoryShape } from "./service.js"
import { managedFileRepositoryLayer, ManagedFileRepository } from "../repository/service.js"
import type { ManagedFileRepositoryOptions as RepositoryOptions } from "../repository/service.js"
import type { RepositoryError } from "../repository/service.js"
import { RevisionConflictError, RevisionStorageError } from "../domain/errors.js"
import { errorMessage } from "@arden-hq/std/errors"

const lockFailure = (
  operation: string,
  cause: unknown
): RevisionStorageError | RevisionConflictError => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { readonly code?: unknown }).code
      : undefined
  if (code === "ELOCKED")
    return new RevisionConflictError({ message: "repository is already locked" })
  return new RevisionStorageError({
    message: `${operation}: ${errorMessage(cause)}`,
    cause
  })
}

const nodeLockFactory: RevisionLockFactoryShape = {
  acquire: Effect.fn("NodeRevisionLock.acquire")(function* (lockPath, staleAfterMs) {
    const lost = Deferred.makeUnsafe<never, RevisionStorageError>()
    const releaseNative = yield* Effect.tryPromise({
      try: () =>
        properLockfile.lock(lockPath, {
          stale: staleAfterMs,
          realpath: false,
          onCompromised: (cause) => {
            Effect.runSync(
              Deferred.fail(
                lost,
                new RevisionStorageError({
                  message: `repository lock compromised: ${cause.message}`,
                  cause
                })
              )
            )
          }
        }),
      catch: (cause) => lockFailure("acquire repository lock", cause)
    })
    let released = false
    const release = Effect.gen(function* () {
      if (released) return
      released = true
      yield* Effect.tryPromise({
        try: () => releaseNative(),
        catch: (cause) =>
          new RevisionStorageError({
            message: `release repository lock: ${errorMessage(cause)}`,
            cause
          })
      })
    })
    return { release, lost: Deferred.await(lost) }
  })
}

/** Node/Electron layer for the complete durable repository service. */
export const managedFileRepositoryNodeLayer = (
  options: RepositoryOptions
): Layer.Layer<ManagedFileRepository, RepositoryError> =>
  Layer.provide(
    managedFileRepositoryLayer(options),
    Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      Layer.succeed(RevisionLockFactory, nodeLockFactory)
    )
  )
