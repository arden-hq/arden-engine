import { Effect } from "effect"
import type { Memory } from "../../memory/service.js"
import { AutomationId } from "../../persistence/automations/model.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import { runItemLoop, type ItemLoopServices } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"
import { withoutTools } from "../../execution/toolset-middleware.js"

export const MEMORY_CAPTURE_AUTOMATION_ID = AutomationId.make("builtin-memory-capture")

const TIDY_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "session_read",
  "session_search_transcripts",
  "wiki_merge_page"
])

const OLDER_BATCHES_PER_JOB = Math.max(1, Number(process.env.ARDEN_CAPTURE_CATCH_UP) || 1)

const makeMemoryCaptureRunner =
  (
    services: ItemLoopServices & {
      readonly memory: Pick<
        Memory["Service"],
        "nextCaptureBatch" | "completeCaptureBatch" | "skipCaptureBatch"
      >
    }
  ): AutomationRunner =>
  (job) => {
    let older = OLDER_BATCHES_PER_JOB
    return runItemLoop(services, {
      label: "Memory Capture",
      kind: "memory",
      next: Effect.fn("MemoryCapture.next")(function* () {
        const batch =
          (yield* services.memory.nextCaptureBatch(false)) ??
          (older-- > 0 ? yield* services.memory.nextCaptureBatch(true) : null)
        return batch === null ? ("idle" as const) : { kind: "memory" as const, batch }
      }),
      commit: (data) => services.memory.completeCaptureBatch(data.batch),
      skip: (data) =>
        services.memory
          .skipCaptureBatch(data.batch)
          .pipe(
            Effect.as(
              `a batch of chat ${data.batch.identity.sessionId} (kept unread and tried again after a day)`
            )
          ),
      summary: (item) =>
        `memory capture: reviewed ${item?.reviewed ?? 0} batch(es), skipped ${item?.skipped ?? 0}`,
      cancelled: "Memory capture cancelled",
      incomplete: "Memory Capture review deferred"
    })(job)
  }

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
  tools: (base) => withoutTools(base, TIDY_ONLY_TOOLS),
  run: (services) =>
    makeMemoryCaptureRunner({
      memory: services.memory,
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
