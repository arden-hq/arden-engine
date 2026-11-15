import { Effect } from "effect"
import type { Wiki } from "../../wiki/service.js"
import type { WikiMaintenanceStore } from "../../persistence/wiki-maintenance/store.js"
import { AutomationId } from "../../persistence/automations/model.js"
import type { AutomationHandlerItems } from "../../persistence/automations/handler-items.js"
import type { HandlerItemDataOf } from "../../persistence/automations/handler-item.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import type { HandlerItemRunner } from "../handler-item-run.js"
import { runItemLoop } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"

const WIKI_MAINTENANCE_AUTOMATION_ID = AutomationId.make("builtin-wiki-maintenance")

const makeWikiMaintenanceRunner = (services: {
  readonly wiki: Pick<Wiki["Service"], "prepareMaintenance">
  readonly maintenance: WikiMaintenanceStore["Service"]
  readonly handlerItems: Pick<
    AutomationHandlerItems["Service"],
    "prepareHandlerItem" | "settleHandlerItem"
  >
  readonly runItem: HandlerItemRunner
}): AutomationRunner => {
  const leaveRefusedRange = Effect.fn("WikiMaintenance.leaveRefusedRange")(function* (
    data: HandlerItemDataOf<"wiki">,
    reason: string | null,
    notes: Array<string>
  ) {
    const refused = yield* services.maintenance.refusal()
    if (refused === undefined || refused.from !== data.processedHead) {
      yield* services.maintenance.refuse({ from: data.processedHead, to: data.sourceHead })
      return "stop" as const
    }
    yield* services.maintenance.compareAndSet({ expected: refused.from, next: refused.to })
    const note = `Tidy moved past the changes up to ${refused.to.slice(0, 12)}: it was blocked on them twice${reason === null ? "" : ` (${reason})`}`
    notes.push(note)
    yield* Effect.logWarning(note)
    return "continue" as const
  })

  return (job) => {
    const notes: Array<string> = []
    return runItemLoop(services, {
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
      blocked: (data, reason) => leaveRefusedRange(data, reason, notes),
      summary: (item) =>
        [
          item === undefined
            ? "tidy: idle"
            : `tidy: reviewed ${item.reviewed}, skipped ${item.skipped}`,
          ...notes
        ].join("; "),
      cancelled: "Tidy cancelled",
      incomplete: "Tidy review incomplete"
    })(job)
  }
}

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
