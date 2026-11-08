import { recordedHistoryReader } from "./recorded-history.js"
import { makeAutomationFollowup } from "./automation-followup.js"
import { AutomationCatalog } from "../automations/catalog.js"
import type { SpaceReviewStore } from "../automations/space-review-store.js"
import type { AutomationHandlerItems } from "../automations/handler-items.js"
import type { HomeLetterInputs } from "../automations/home-letter-inputs.js"
import { AutomationQueue } from "../automations/queue.js"
import type { AutomationTriggers } from "../automations/triggers.js"
import type { WikiEventOutbox } from "../automations/wiki-event-outbox.js"
import { makeAutomationCatalogEdits } from "./automation-catalog-edit.js"
import { makeAutomationCatalog } from "./automation-catalog.js"
import { makeAutomationDiagnostics } from "./automation-diagnostics.js"
import { makeHandlerItems } from "./automation-handler-item.js"
import { makeHomeLetterInputs } from "./automation-home-input.js"
import { makeEventScreens, makeRunEvents } from "./automation-event-batch.js"
import { makeAutomationJobs } from "./automation-jobs.js"
import { makeAutomationRowReads, type AutomationStoreDeps } from "./automation-rows.js"
import { makeAutomationRunRequests } from "./automation-run-requests.js"
import { makeForkSessions } from "./automation-fork-session.js"
import { makeOwnChats } from "./automation-own-chat.js"
import { makeAutomationTriggerFeed } from "./automation-trigger-feed.js"
import { makeSpaceReviewStore } from "./space-review.js"
import { seedSystemAutomations } from "./system-automations.js"

export const makeAutomationStores = (
  deps: AutomationStoreDeps
): {
  readonly catalog: AutomationCatalog["Service"]
  readonly queue: AutomationQueue["Service"]
  readonly triggers: AutomationTriggers["Service"]
  readonly wikiOutbox: WikiEventOutbox["Service"]
  readonly homeLetterInputs: HomeLetterInputs["Service"]
  readonly spaceReviews: SpaceReviewStore["Service"]
  readonly handlerItems: AutomationHandlerItems["Service"]
} => {
  const { writer, reader, sessionEvents, rules } = deps
  const { triggers, outbox } = makeAutomationTriggerFeed(deps)
  const catalog = AutomationCatalog.of({
    history: recordedHistoryReader(deps, "automation"),
    diagnostics: makeAutomationDiagnostics({ writer, reader }),
    get: makeAutomationRowReads(deps).get,
    ...makeAutomationCatalog(deps),
    ...makeAutomationCatalogEdits(deps),
    seedSystemAutomations: (specs) => seedSystemAutomations({ writer, sessionEvents, rules, specs })
  })
  return {
    catalog,
    queue: AutomationQueue.of({
      ...makeAutomationRunRequests(deps),
      setFollowup: makeAutomationFollowup(deps),
      runEvents: makeRunEvents(deps),
      ...makeForkSessions(deps),
      ...makeOwnChats(deps),
      ...makeEventScreens(deps),
      jobs: makeAutomationJobs(deps)
    }),
    triggers,
    wikiOutbox: outbox,
    homeLetterInputs: makeHomeLetterInputs({ writer }),
    spaceReviews: makeSpaceReviewStore({ writer, sessionEvents }),
    handlerItems: makeHandlerItems({ writer, rules })
  }
}
