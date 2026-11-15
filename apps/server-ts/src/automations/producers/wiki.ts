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

const pollMemoryChanges = Effect.fn("Wiki.pollChanges")(function* () {
  const wiki = yield* Wiki
  const index = yield* WikiEmbeddingIndex
  yield* logAndContinue(
    wiki.checkOutsideEdits(),
    "Memory changes made outside Arden were not checked"
  )
  const publishExit = yield* Effect.exit(wiki.publishChanges())
  yield* logAndContinue(
    wiki.snapshot().pipe(Effect.flatMap(index.schedule)),
    "The search index was not told about Memory changes"
  )
  return yield* publishExit
})

const logAndContinue = <A, E, R>(
  step: Effect.Effect<A, E, R>,
  failure: string
): Effect.Effect<void, never, R> =>
  step.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning(failure, cause))
  )

export const wikiEventProducer: AutomationEventProducer<"wiki.changed", Wiki | WikiEmbeddingIndex> =
  {
    eventType: "wiki.changed",
    source: { kind: "always", poll: pollMemoryChanges() },
    failureMessage: "Wiki event publication remains pending"
  }
