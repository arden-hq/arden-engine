import { Effect } from "effect"
import type { Wiki } from "../../wiki/service.js"
import type { ReaderPosition } from "../../persistence/reader-position.js"
import { AutomationId } from "../../persistence/automations/model.js"
import type { HandlerItemDataOf } from "../../persistence/automations/handler-item.js"
import { PROMPTS } from "../../prompts/catalog.js"
import { runItemLoop, type ItemLoopServices } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"

const WIKI_MAINTENANCE_AUTOMATION_ID = AutomationId.make("builtin-wiki-maintenance")

const makeWikiMaintenanceRunner = (
  services: ItemLoopServices & {
    readonly wiki: Pick<Wiki["Service"], "prepareMaintenance">
    readonly position: ReaderPosition<string | null>
  }
): AutomationRunner => {
  const moveOn = (data: HandlerItemDataOf<"wiki">) =>
    services.position.advance({ expected: data.processedHead, next: data.sourceHead })
  return runItemLoop(services, {
    label: "Wiki Maintenance",
    kind: "wiki",
    next: Effect.fn("WikiMaintenance.next")(function* () {
      const processedHead = yield* services.position.read()
      const prepared = yield* services.wiki.prepareMaintenance({ processedHead })
      if (prepared.kind === "idle") return "idle" as const
      if (prepared.kind === "advance") {
        yield* services.position.advance({ expected: processedHead, next: prepared.sourceHead })
        return "advance" as const
      }
      return {
        kind: "wiki" as const,
        processedHead,
        sourceHead: prepared.sourceHead,
        markdown: prepared.markdown
      }
    }),
    commit: moveOn,
    skip: (data) =>
      moveOn(data).pipe(Effect.as(`the Wiki changes up to ${data.sourceHead.slice(0, 12)}`)),
    summary: (item) =>
      item === undefined
        ? "wiki maintenance: idle"
        : `wiki maintenance: reviewed ${item.reviewed}, skipped ${item.skipped}`,
    cancelled: "Wiki maintenance cancelled",
    incomplete: "Wiki Maintenance review incomplete"
  })
}

export const wikiMaintenanceHandler: SystemAutomationHandler<"wiki_maintenance"> = {
  spec: {
    automationId: WIKI_MAINTENANCE_AUTOMATION_ID,
    name: "Wiki Maintenance",
    description: "Reconcile cross-page Wiki consistency after each Wiki commit.",
    prompt: PROMPTS.wikiMaintenance,
    handler: "wiki_maintenance",
    triggers: [
      {
        type: "event",
        event_type: "wiki.changed",
        run_only_if: { kind: "any_event" },
        condition: { kind: "none" }
      }
    ],
    enabled: true,
    cooldownMinutes: null,
    toolScope: "memory_capture",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    promptEdit: "owner",
    triggerScope: "any",
    rearmOnSeed: false
  },
  item: handlerItemText("wiki", (data) => data.markdown),
  run: (services) =>
    makeWikiMaintenanceRunner({
      wiki: services.wiki,
      position: services.positions.maintenance,
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
