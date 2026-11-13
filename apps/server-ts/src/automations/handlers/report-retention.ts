import { Effect } from "effect"
import type { HandlerItemDataOf } from "../../persistence/automations/handler-item.js"
import type { AutomationHandlerItems } from "../../persistence/automations/handler-items.js"
import { AutomationId } from "../../persistence/automations/model.js"
import { withoutTools } from "../../execution/toolset-middleware.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import { REPORT_RETENTION_AUTOMATION } from "../../wiki/retire-reports.js"
import type { Wiki } from "../../wiki/service.js"
import type { HandlerItemRunner } from "../handler-item-run.js"
import { runItemLoop } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"
import { MAINTENANCE_ONLY_TOOLS } from "./memory-capture.js"

const REPORT_RETENTION_AUTOMATION_ID = AutomationId.make(REPORT_RETENTION_AUTOMATION)

/** Model runs one part of a month gets before its reports are archived without a summary. */
const SUMMARY_ATTEMPTS = 2

type ReportsItem = HandlerItemDataOf<"reports">

const makeReportRetentionRunner =
  (services: {
    readonly wiki: Pick<Wiki["Service"], "stepReportRetention" | "retireReportPart">
    readonly handlerItems: Pick<
      AutomationHandlerItems["Service"],
      "prepareHandlerItem" | "settleHandlerItem"
    >
    readonly runItem: HandlerItemRunner
  }): AutomationRunner =>
  (job) => {
    const part = (data: ReportsItem) => ({
      directory: data.directory,
      month: data.month,
      pageIds: data.pageIds
    })
    // A summary can fail: the model cannot read a report, or never fits the size limit. The
    // reports are then archived with a note in place of the summary. A month that waited for a
    // summary would be retried every day and would hold up every month after it.
    const failures = new Map<string, number>()
    const unsummarized = Effect.fn("ReportRetention.unsummarized")(function* (data: ReportsItem) {
      const key = `${data.directory}/${data.month}/${data.pageIds[0] ?? ""}`
      const failed = (failures.get(key) ?? 0) + 1
      failures.set(key, failed)
      if (failed < SUMMARY_ATTEMPTS) return
      yield* services.wiki.retireReportPart({ ...part(data), summary: "skip" })
    })
    return runItemLoop(services, {
      label: "Report Retention",
      kind: "reports",
      // A month that needs no summary is archived here, with no model run.
      next: Effect.fn("ReportRetention.next")(function* () {
        const step = yield* services.wiki.stepReportRetention()
        switch (step.kind) {
          case "idle":
            return "idle" as const
          case "retired":
            return "advance" as const
          case "summarize":
            return {
              kind: "reports" as const,
              directory: step.directory,
              month: step.month,
              pageIds: step.pageIds,
              markdown: step.markdown
            }
        }
      }),
      commit: Effect.fn("ReportRetention.commit")(function* (data) {
        const result = yield* services.wiki.retireReportPart({ ...part(data), summary: "required" })
        if (result.kind === "no_summary") yield* unsummarized(data)
      }),
      blocked: (data) => unsummarized(data).pipe(Effect.as("continue" as const)),
      summary: (item) =>
        item === undefined
          ? "report retention: nothing past retention needed a summary"
          : `report retention: ${item.reviewed} summary run(s) finished, ${item.skipped} did not`,
      cancelled: "Report retention cancelled",
      incomplete: "Report retention stopped before a summary run finished; its reports stay"
    })(job)
  }

export const reportRetentionHandler: SystemAutomationHandler<"report_retention"> = {
  spec: {
    automationId: REPORT_RETENTION_AUTOMATION_ID,
    name: "Report Retention",
    description:
      "Archive dated reports past their directory's Keep rule, after writing a monthly summary where the rule asks for one.",
    prompt: PROMPT_TEXT.reportRetention,
    handler: "report_retention",
    triggers: [{ type: "time", at: "03:40", days: "daily" }],
    enabled: true,
    cooldownMinutes: null,
    toolScope: "memory_capture",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    runsModel: true,
    rearmOnSeed: false
  },
  item: handlerItemText("reports", (data) => data.markdown),
  // The summary is written from the reports alone.
  tools: (base) => withoutTools(base, MAINTENANCE_ONLY_TOOLS),
  run: (services) =>
    makeReportRetentionRunner({
      wiki: services.wiki,
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
