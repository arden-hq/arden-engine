import { Effect } from "effect"
import type { AutomationJobResult } from "../../persistence/automations/store.js"
import { AutomationId } from "../../persistence/automations/model.js"
import type { StoragePolicyStore } from "../../persistence/storage/store.js"
import type { Wiki } from "../../wiki/service.js"
import { NO_CHAT_RUN, jobResult } from "../runner.js"
import type { SystemAutomationHandler } from "../system-handler.js"

const collectManagedHistory = Effect.fn("ManagedHistoryRunner")(function* (services: {
  readonly retentionPolicy: Pick<StoragePolicyStore["Service"], "retention">
  readonly wiki: Pick<Wiki["Service"], "collectHistory">
}): Effect.fn.Return<AutomationJobResult, Error> {
  const retention = yield* services.retentionPolicy.retention()
  if (retention.wikiHistoryDays === null) {
    return jobResult.withoutRun(
      "no_input",
      "Automatic Wiki history cleanup is off in Storage settings."
    )
  }
  const report = yield* services.wiki.collectHistory({ gracePeriodDays: retention.wikiHistoryDays })
  return jobResult.completed(
    report.removed === 0 ? "no_change" : "finished",
    `memory storage maintenance: scanned ${report.scanned}, removed ${report.removed}, ` +
      `retained ${report.retained}, bytes removed ${report.bytesRemoved}`,
    NO_CHAT_RUN
  )
})

export const managedHistoryHandler: SystemAutomationHandler<"managed_history_collection"> = {
  spec: {
    automationId: AutomationId.make("builtin-memory-storage-maintenance"),
    name: "Memory Storage Maintenance",
    description: "Collect expired unreachable managed-history objects.",
    prompt: "Collect expired unreachable managed-history objects.",
    handler: "managed_history_collection",
    triggers: [{ type: "time", every: "7d" }],
    enabled: true,
    cooldownMinutes: null,
    toolScope: "read_only",
    contextMode: "fresh",
    chatSession: false,
    manualRun: true,
    runsModel: false,
    rearmOnSeed: false
  },
  run: (services) => () => collectManagedHistory(services)
}
