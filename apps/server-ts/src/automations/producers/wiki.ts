import { Effect } from "effect"

import { WikiEmbeddingIndex } from "../../embedding/wiki-index.js"
import type { AutomationTriggerEvent } from "../../persistence/automations/model.js"
import type { WikiCommitSource } from "../../wiki/commit.js"
import { Wiki } from "../../wiki/service.js"
import type { AutomationEventProducer } from "../event-producer.js"

export const wikiChangedEvent = (input: {
  readonly paths: ReadonlyArray<string>
  readonly revision: string
  readonly savedAt: string
  readonly source: WikiCommitSource
  readonly hasSpacePage: boolean
  readonly producedBy: string | null
  readonly chainDepth: number
}): AutomationTriggerEvent => ({
  eventType: "wiki.changed",
  eventKey: input.revision,
  producedBy: input.producedBy,
  chainDepth: input.chainDepth,
  context: {
    change: {
      paths: [...input.paths],
      page_count: input.paths.length,
      saved_at: input.savedAt,
      source: input.source,
      has_space_page: input.hasSpacePage
    }
  }
})

/**
 * The one-minute Memory poll: take in changes made outside Arden, announce every new commit, then
 * let the search index catch up with the head. Nothing on a chat turn reads the files themselves.
 * Each step runs whether or not the one before it failed; a failed announcement still fails the
 * poll, so it is reported and retried.
 */
const pollMemoryChanges = Effect.fn("Wiki.pollChanges")(function* () {
  const wiki = yield* Wiki
  const index = yield* WikiEmbeddingIndex
  yield* wiki
    .checkOutsideEdits()
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Memory changes made outside Arden were not checked", cause)
      )
    )
  const published = yield* Effect.exit(wiki.publishChanges())
  yield* wiki.snapshot().pipe(
    Effect.flatMap(index.schedule),
    Effect.catchCause((cause) =>
      Effect.logWarning("The search index was not told about Memory changes", cause)
    )
  )
  return yield* published
})

export const wikiEventProducer: AutomationEventProducer<"wiki.changed", Wiki | WikiEmbeddingIndex> =
  {
    eventType: "wiki.changed",
    source: { kind: "always", poll: pollMemoryChanges() },
    failureMessage: "Wiki event publication remains pending"
  }
