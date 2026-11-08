import { Effect } from "effect"
import type { Memory } from "../../memory/service.js"
import { AutomationId } from "../../persistence/automations/model.js"
import type { AutomationHandlerItems } from "../../persistence/automations/handler-items.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import type { HandlerItemRunner } from "../handler-item-run.js"
import { runItemLoop } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"

export const MEMORY_CAPTURE_AUTOMATION_ID = AutomationId.make("builtin-memory-capture")

const makeMemoryCaptureRunner = (services: {
  readonly memory: Pick<Memory["Service"], "nextCaptureBatch" | "completeCaptureBatch">
  readonly handlerItems: Pick<
    AutomationHandlerItems["Service"],
    "prepareHandlerItem" | "settleHandlerItem"
  >
  readonly runItem: HandlerItemRunner
}): AutomationRunner =>
  runItemLoop(services, {
    label: "Memory Capture",
    kind: "memory",
    next: () =>
      services.memory
        .nextCaptureBatch()
        .pipe(
          Effect.map((batch) =>
            batch === null ? ("idle" as const) : { kind: "memory" as const, batch }
          )
        ),
    commit: (data) => services.memory.completeCaptureBatch(data.batch),
    summary: (item) =>
      `memory capture: reviewed ${item?.reviewed ?? 0} batch(es), skipped ${item?.skipped ?? 0}`,
    cancelled: "Memory capture cancelled",
    incomplete: "Memory Capture review deferred"
  })

export const memoryCaptureHandler: SystemAutomationHandler<"memory_capture"> = {
  spec: {
    automationId: MEMORY_CAPTURE_AUTOMATION_ID,
    name: "Memory Capture",
    description: "Update the Markdown Wiki from recent chat evidence.",
    prompt: PROMPT_TEXT.memoryCapture,
    handler: "memory_capture",
    triggers: [
      { type: "idle", idle_minutes: 10 },
      { type: "count", every_n: 10 },
      { type: "time", at: "02:30", days: "daily" }
    ],
    enabled: true,
    cooldownMinutes: 5,
    toolScope: "memory_capture",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    runsModel: true,
    rearmOnSeed: true
  },
  item: handlerItemText("memory", (data) => data.batch.markdown),
  run: (services) =>
    makeMemoryCaptureRunner({
      memory: services.memory,
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
