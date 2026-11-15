import { Effect } from "effect"
import { TIDY_AUTOMATION_ID } from "../../wiki/commit.js"
import type { Wiki } from "../../wiki/service.js"
import type { WikiMaintenanceStore } from "../../persistence/wiki-maintenance/store.js"
import { AutomationId } from "../../persistence/automations/model.js"
import type { AutomationHandlerItems } from "../../persistence/automations/handler-items.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import type { HandlerItemRunner } from "../handler-item-run.js"
import { runItemLoop } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"

const WIKI_MAINTENANCE_AUTOMATION_ID = AutomationId.make(TIDY_AUTOMATION_ID)

const makeWikiMaintenanceRunner = (services: {
  readonly wiki: Pick<Wiki["Service"], "prepareMaintenance">
  readonly maintenance: WikiMaintenanceStore["Service"]
  readonly handlerItems: Pick<
    AutomationHandlerItems["Service"],
    "prepareHandlerItem" | "settleHandlerItem"
  >
  readonly runItem: HandlerItemRunner
}): AutomationRunner =>
  runItemLoop(services, {
    label: "Tidy",
    kind: "wiki",
    next: Effect.fn("WikiMaintenance.next")(function* () {
      const processedHead = yield* services.maintenance.processedHead()
      const prepared = yield* services.wiki.prepareMaintenance({ processedHead })
      if (prepared.kind === "idle") return "idle" as const
      if (prepared.kind === "advance") {
        yield* services.maintenance.compareAndSet({
          expected: processedHead,
          next: prepared.sourceHead
        })
        return "advance" as const
      }
      return {
        kind: "wiki" as const,
        processedHead,
        sourceHead: prepared.sourceHead,
        markdown: prepared.markdown
      }
    }),
    commit: (data) =>
      services.maintenance.compareAndSet({ expected: data.processedHead, next: data.sourceHead }),
    summary: (item) =>
      item === undefined
        ? "tidy: idle"
        : `tidy: reviewed ${item.reviewed}, skipped ${item.skipped}`,
    cancelled: "Tidy cancelled",
    incomplete: "Tidy review incomplete"
  })

export const wikiMaintenanceHandler: SystemAutomationHandler<"wiki_maintenance"> = {
  spec: {
    automationId: WIKI_MAINTENANCE_AUTOMATION_ID,
    name: "Tidy",
    description: "Reconcile cross-page Wiki consistency after each Wiki commit.",
    prompt: PROMPT_TEXT.wikiMaintenance,
    handler: "wiki_maintenance",
    triggers: [{ type: "event", event_type: "wiki.changed" }],
    enabled: true,
    cooldownMinutes: null,
    toolScope: "memory_capture",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    runsModel: true,
    rearmOnSeed: false
  },
  item: handlerItemText("wiki", (data) => data.markdown),
  run: (services) =>
    makeWikiMaintenanceRunner({
      wiki: services.wiki,
      maintenance: services.wikiMaintenance,
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
