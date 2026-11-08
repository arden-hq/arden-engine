import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"

import type { SpaceStore } from "../persistence/spaces/store.js"
import type { MemoryCaptureBatchIdentity } from "../persistence/memory/store.js"
import {
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority
} from "./authority.js"
import { commitWiki, updatePage, type WikiCommitIdentity } from "./commit.js"
import { withConflictDetail } from "./conflict.js"
import { mapRevisionError, type WikiError, wikiError } from "./errors.js"
import type { WikiListingMethods } from "./listing.js"
import { parseWikiPage, writtenContent } from "./page.js"
import { loadSnapshot } from "./snapshot.js"
import { sha256Hex } from "@arden-hq/std/hash"

const receiptKey = (identity: MemoryCaptureBatchIdentity, phase: "patch" | "final"): string =>
  `memory-capture-${phase}:${sha256Hex(
    JSON.stringify({
      version: 1,
      phase,
      session_id: identity.sessionId,
      context_generation: identity.contextGeneration,
      start: identity.start,
      end: identity.end
    })
  )}`

const memoryCapturePatchReceiptKey = (identity: MemoryCaptureBatchIdentity): string =>
  receiptKey(identity, "patch")

const memoryCaptureFinalReceiptKey = (identity: MemoryCaptureBatchIdentity): string =>
  receiptKey(identity, "final")

interface WikiCaptureEdit {
  readonly pageId: string
  readonly content: string
  readonly expectedVersion: string
}

interface WikiCapturePatchSetInput {
  readonly edits: ReadonlyArray<WikiCaptureEdit>
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly batch: MemoryCaptureBatchIdentity
  readonly commit: Omit<WikiCommitIdentity, "origin">
}

interface WikiCapturePatchSetResult {
  readonly pages: ReadonlyArray<WikiPage>
  readonly changed: boolean
}

export interface WikiCaptureMethods {
  readonly applyCapturePatchSet: (
    input: WikiCapturePatchSetInput
  ) => Effect.Effect<WikiCapturePatchSetResult, WikiError>
  readonly finalizeCaptureBatch: (
    batch: MemoryCaptureBatchIdentity
  ) => Effect.Effect<void, WikiError>
  readonly hasFinalizedCaptureBatch: (
    batch: MemoryCaptureBatchIdentity
  ) => Effect.Effect<boolean, WikiError>
}

export const makeWikiCaptureMethods = (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  read: WikiListingMethods["read"]
): WikiCaptureMethods => {
  const applyCapturePatchSet = Effect.fn("Wiki.applyCapturePatchSet")(function* (
    input: WikiCapturePatchSetInput
  ): Effect.fn.Return<WikiCapturePatchSetResult, WikiError> {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        if (input.edits.length === 0 || input.edits.length > 12) {
          return yield* wikiError("update", "invalid", "A capture patch set needs 1 to 12 edits")
        }
        if (new Set(input.edits.map((edit) => edit.pageId)).size !== input.edits.length) {
          return yield* wikiError("update", "invalid", "A capture patch set repeats a page")
        }
        const snapshot = yield* loadSnapshot(repository, "update")
        const byId = new Map(snapshot.pages.map((record) => [record.page.pageId, record] as const))
        const replacements = yield* Effect.forEach(
          input.edits,
          Effect.fn("Wiki.captureReplacement")(function* (edit: WikiCaptureEdit) {
            const current = byId.get(edit.pageId)
            if (
              current === undefined ||
              (snapshot.head === input.expectedHead &&
                current.resource.versionId !== edit.expectedVersion)
            ) {
              return yield* wikiError(
                "update",
                "conflict",
                "Wiki page changed before the capture patch set",
                {
                  pageId: edit.pageId
                }
              )
            }
            if (current.page.lifecycle !== "active") {
              return yield* wikiError(
                "update",
                "invalid",
                "Only active Wiki pages can be updated",
                {
                  pageId: edit.pageId
                }
              )
            }
            if (current.resource.path.toLowerCase() === "health.md") {
              return yield* wikiError("update", "blocked", "Wiki health is backend-managed", {
                pageId: edit.pageId
              })
            }
            const replacement = yield* parseWikiPage(edit.content, edit.pageId).pipe(
              Effect.mapError((cause) =>
                wikiError("update", "invalid", cause.message, {
                  pageId: edit.pageId,
                  cause
                })
              )
            )
            if (replacement.lifecycle !== "active") {
              return yield* wikiError(
                "update",
                "invalid",
                "A capture patch cannot create a redirect",
                {
                  pageId: edit.pageId
                }
              )
            }
            const content = yield* writtenContent(replacement).pipe(
              Effect.mapError((cause) =>
                wikiError("update", "invalid", cause.message, { pageId: edit.pageId, cause })
              )
            )
            return { current, expectedVersion: edit.expectedVersion, content }
          })
        )
        const boundary = yield* resolveWikiWriteBoundary(
          spaces,
          input.authority,
          snapshot,
          "update"
        )
        yield* requireWikiWritePaths(
          boundary,
          "update",
          replacements.map(({ current }) => current.resource.path)
        )
        const changed =
          snapshot.head === input.expectedHead
            ? replacements.filter(({ current, content }) => content !== current.page.content)
            : replacements
        if (changed.length > 0) {
          yield* commitWiki(
            repository,
            {
              actor: input.commit.actor,
              origin: {
                kind: "capture",
                replayKey: memoryCapturePatchReceiptKey(input.batch),
                sessionId: input.batch.sessionId
              },
              reason: input.commit.reason,
              expectedRevision: input.expectedHead
            },
            changed.map(({ current, expectedVersion, content }) =>
              updatePage(
                {
                  resourceId: current.resource.resourceId,
                  versionId: expectedVersion
                },
                content
              )
            )
          ).pipe(Effect.mapError(mapRevisionError("update")))
        } else if (
          (yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("update")))) !==
          snapshot.head
        ) {
          return yield* wikiError("update", "conflict", "Wiki changed during the capture patch set")
        }
        const pages = yield* Effect.forEach(
          replacements,
          ({ current }) => read(current.page.pageId),
          { concurrency: 8 }
        )
        return { pages, changed: changed.length > 0 }
      })
    )
  })

  const finalizeCaptureBatch = Effect.fn("Wiki.finalizeCaptureBatch")(function* (
    batch: MemoryCaptureBatchIdentity
  ) {
    const key = memoryCaptureFinalReceiptKey(batch)
    yield* repository
      .finalizeIdempotencyReceipt(key, key)
      .pipe(Effect.mapError(mapRevisionError("update")))
  })

  const hasFinalizedCaptureBatch = Effect.fn("Wiki.hasFinalizedCaptureBatch")(function* (
    batch: MemoryCaptureBatchIdentity
  ) {
    const receipt = yield* repository
      .idempotencyReceipt(memoryCaptureFinalReceiptKey(batch))
      .pipe(Effect.mapError(mapRevisionError("read")))
    return receipt !== null
  })

  return { applyCapturePatchSet, finalizeCaptureBatch, hasFinalizedCaptureBatch }
}
