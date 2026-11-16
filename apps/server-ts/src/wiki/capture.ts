import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"

import type { MemoryCaptureBatchIdentity } from "../persistence/memory/store.js"
import { mapRevisionError, type WikiError } from "./errors.js"
import { sha256Hex } from "@arden-hq/std/hash"

// Version 2 names the batch by its chat, its start and end positions and the message at its
// end, which tells a batch apart from a later one that reuses its numbers after a revert.
export const captureBatchKey = (identity: MemoryCaptureBatchIdentity): string =>
  `memory-capture-final:${sha256Hex(
    JSON.stringify({
      version: 2,
      phase: "final",
      session_id: identity.sessionId,
      start: identity.start,
      end: identity.end,
      end_message_id: identity.endMessageId
    })
  )}`

/**
 * A Capture save is keyed by its run and its exact tool arguments: the same arguments again in
 * the same run land once, and any other save is a new one.
 */
export const captureSaveKey = (runId: string, request: unknown): string =>
  `memory-capture-save:${sha256Hex(JSON.stringify({ run_id: runId, request }))}`

export interface WikiCaptureMethods {
  readonly finalizeCaptureBatch: (
    batch: MemoryCaptureBatchIdentity
  ) => Effect.Effect<void, WikiError>
  /** Whether the Capture write that `key` names landed. */
  readonly hasCaptureReceipt: (key: string) => Effect.Effect<boolean, WikiError>
}

export const makeWikiCaptureMethods = (
  repository: ManagedFileRepositoryShape
): WikiCaptureMethods => {
  const finalizeCaptureBatch = Effect.fn("Wiki.finalizeCaptureBatch")(function* (
    batch: MemoryCaptureBatchIdentity
  ) {
    const key = captureBatchKey(batch)
    yield* repository
      .finalizeIdempotencyReceipt(key, key)
      .pipe(Effect.mapError(mapRevisionError("update")))
  })

  const hasCaptureReceipt = Effect.fn("Wiki.hasCaptureReceipt")(function* (key: string) {
    const receipt = yield* repository
      .idempotencyReceipt(key)
      .pipe(Effect.mapError(mapRevisionError("read")))
    return receipt !== null
  })

  return { finalizeCaptureBatch, hasCaptureReceipt }
}
