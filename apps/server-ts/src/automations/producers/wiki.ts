import type { AutomationTriggerEvent } from "../../persistence/automations/model.js"
import type { WikiCommitSource } from "../../wiki/commit.js"
import { Wiki } from "../../wiki/service.js"
import type { AutomationEventProducer } from "../event-producer.js"

export const wikiChangedEvent = (input: {
  readonly paths: ReadonlyArray<string>
  readonly revision: string
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
      source: input.source,
      has_space_page: input.hasSpacePage
    }
  }
})

export const wikiEventProducer: AutomationEventProducer<"wiki.changed", Wiki> = {
  eventType: "wiki.changed",
  source: {
    kind: "always",
    poll: Wiki.use((wiki) => wiki.publishChanges())
  },
  failureMessage: "Wiki event publication remains pending"
}
