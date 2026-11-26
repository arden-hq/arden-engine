import { Effect, Layer } from "effect"

import { WikiEventOutbox } from "../persistence/automations/wiki-event-outbox.js"
import { causedChainDepth } from "../persistence/automations/chain-depth.js"
import { WIKI_ORIGIN_KIND, wikiOriginSource, type WikiCommitOrigin } from "../wiki/origin.js"
import { shownPathToRuns } from "../wiki/change.js"
import { isImportedPath } from "../wiki/collections.js"
import { WikiChangeSink, WikiChangeSinkError } from "../wiki/publication.js"
import { wikiChangedEvent } from "./producers/wiki.js"
import { MEMORY_CAPTURE_AUTOMATION_ID } from "./handlers/memory-capture.js"

const producerWakeDepth = (origin: WikiCommitOrigin): number => {
  switch (origin.kind) {
    case WIKI_ORIGIN_KIND.automation:
    case WIKI_ORIGIN_KIND.upkeep:
    case WIKI_ORIGIN_KIND.agent:
      return origin.chainDepth ?? 0
    case WIKI_ORIGIN_KIND.capture:
    case WIKI_ORIGIN_KIND.user:
    case WIKI_ORIGIN_KIND.forget:
    case WIKI_ORIGIN_KIND.rules:
    case WIKI_ORIGIN_KIND.space_page:
    case WIKI_ORIGIN_KIND.system:
      return 0
  }
}

const automationOfOrigin = (origin: WikiCommitOrigin): string | null => {
  switch (origin.kind) {
    case WIKI_ORIGIN_KIND.automation:
    case WIKI_ORIGIN_KIND.upkeep:
      return origin.automationId
    case WIKI_ORIGIN_KIND.capture:
      return MEMORY_CAPTURE_AUTOMATION_ID
    case WIKI_ORIGIN_KIND.user:
    case WIKI_ORIGIN_KIND.forget:
    case WIKI_ORIGIN_KIND.rules:
    case WIKI_ORIGIN_KIND.agent:
    case WIKI_ORIGIN_KIND.space_page:
    case WIKI_ORIGIN_KIND.system:
      return null
  }
}

const announcedPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((path) => !isImportedPath(path) && shownPathToRuns(path))

const sinkError = (cause: unknown) => new WikiChangeSinkError({ cause })

const automationWikiChangeSink = (
  outbox: WikiEventOutbox["Service"]
): WikiChangeSink["Service"] => ({
  cursor: (initialRevision) =>
    outbox.wikiPublicationCursor(initialRevision).pipe(Effect.mapError(sinkError)),
  publish: (change) => {
    const paths = announcedPaths(change.paths)
    return outbox
      .publishWikiChange({
        previousRevision: change.previousRevision,
        revision: change.revision,
        event:
          paths.length === 0 && change.paths.length > 0
            ? undefined
            : wikiChangedEvent({
                paths,
                revision: change.revision,
                savedAt: change.savedAt,
                source: wikiOriginSource(change.origin),
                hasSpacePage: change.hasSpacePage,
                producedBy: automationOfOrigin(change.origin),
                chainDepth: causedChainDepth(
                  automationOfOrigin(change.origin),
                  producerWakeDepth(change.origin)
                )
              })
      })
      .pipe(Effect.mapError(sinkError))
  }
})

export const automationWikiChangeSinkLayer: Layer.Layer<WikiChangeSink, never, WikiEventOutbox> =
  Layer.effect(
    WikiChangeSink,
    Effect.gen(function* () {
      return automationWikiChangeSink(yield* WikiEventOutbox)
    })
  )
