import { Effect, Layer } from "effect"

import { WikiEventOutbox } from "../persistence/automations/wiki-event-outbox.js"
import { causedChainDepth } from "../persistence/automations/chain-depth.js"
import { wikiOriginSource, type WikiCommitOrigin } from "../wiki/commit.js"
import { isImportedPath } from "../wiki/imported.js"
import { WikiChangeSink, WikiChangeSinkError } from "../wiki/publication.js"
import { wikiChangedEvent } from "./producers/wiki.js"
import { MEMORY_CAPTURE_AUTOMATION_ID } from "./handlers/memory-capture.js"

const producerWakeDepth = (origin: WikiCommitOrigin): number =>
  origin.kind === "automation" ? (origin.chainDepth ?? 0) : 0

const producingAutomation = (origin: WikiCommitOrigin): string | null => {
  switch (origin.kind) {
    case "automation":
      return origin.automationId
    case "capture":
      return MEMORY_CAPTURE_AUTOMATION_ID
    case "user":
    case "agent":
    case "space_page":
    case "system":
      return null
  }
}

const announcedPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((path) => !isImportedPath(path))

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
                source: wikiOriginSource(change.origin),
                hasSpacePage: change.hasSpacePage,
                producedBy: producingAutomation(change.origin),
                chainDepth: causedChainDepth(
                  producingAutomation(change.origin),
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
