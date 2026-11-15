import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"

import type { MemoryCaptureBatchIdentity } from "../persistence/memory/store.js"
import { mapRevisionError, type WikiError } from "./errors.js"
import { sha256Hex } from "@arden-hq/std/hash"

// Version 2 names the batch by its chat, its start and end positions and the message at its
// end, which tells a batch apart from a later one that reuses its numbers after a revert.
// The patch set and the batch's end are each once per batch; any other write is once per tool
// call `request`.
export const captureReplayKey = (
  identity: MemoryCaptureBatchIdentity,
  phase: string,
  request?: unknown
): string =>
  `memory-capture-${phase}:${sha256Hex(
    JSON.stringify({
      version: 2,
      phase,
      session_id: identity.sessionId,
      start: identity.start,
      end: identity.end,
      end_message_id: identity.endMessageId,
      request
    })
  )}`

export interface WikiCaptureMethods {
  readonly finalizeCaptureBatch: (
    batch: MemoryCaptureBatchIdentity
  ) => Effect.Effect<void, WikiError>
  readonly hasFinalizedCaptureBatch: (
    batch: MemoryCaptureBatchIdentity
  ) => Effect.Effect<boolean, WikiError>
}

export const makeWikiCaptureMethods = (
  repository: ManagedFileRepositoryShape
): WikiCaptureMethods => {
  const finalizeCaptureBatch = Effect.fn("Wiki.finalizeCaptureBatch")(function* (
    batch: MemoryCaptureBatchIdentity
  ) {
    const key = captureReplayKey(batch, "final")
    yield* repository
      .finalizeIdempotencyReceipt(key, key)
      .pipe(Effect.mapError(mapRevisionError("update")))
  })

  const hasFinalizedCaptureBatch = Effect.fn("Wiki.hasFinalizedCaptureBatch")(function* (
    batch: MemoryCaptureBatchIdentity
  ) {
    const receipt = yield* repository
      .idempotencyReceipt(captureReplayKey(batch, "final"))
      .pipe(Effect.mapError(mapRevisionError("read")))
    return receipt !== null
  })

  return { finalizeCaptureBatch, hasFinalizedCaptureBatch }
}
