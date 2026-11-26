import { SYSTEM_HANDLER } from "../../persistence/automations/model.js"
import { HomeLetterBodySchema } from "../../persistence/home/letter-schema.js"
import { Effect } from "effect"
import type { ChatMessage } from "../../chat/message.js"
import type { AutomationQueue } from "../../persistence/automations/queue.js"
import type {
  AutomationJobLease,
  AutomationJobResult
} from "../../persistence/automations/store.js"
import type { HomeLetterInputs } from "../../persistence/automations/home-letter-inputs.js"
import { HOME_LETTER_DISPOSITION, type HomeStore } from "../../persistence/home/store.js"
import { HOME_LETTER_AUTOMATION_ID } from "../../persistence/automations/model.js"
import { HOME_LETTER_PROMPT, HOME_LETTER_RULES, homeLetterInput } from "../home-letter-prompt.js"
import { HOME_LETTER_TOOL, withHomeLetterTool } from "../home-letter-tool.js"
import { HANDLER_READ, readHandlerRun } from "../handler-tool-result.js"
import { runByRule } from "../job-run.js"
import { jobResult, type AutomationRunner, type AwaitAutomationRun } from "../runner.js"
import type { SystemAutomationHandler } from "../system-handler.js"

const UNREADY = {
  no_change: ["no_change", "Home already covers this evidence"],
  skipped_no_input: ["no_input", "No current Home evidence"],
  superseded: ["superseded", "Newer Home evidence replaced this input"]
} as const

const makeHomeLetterRunner = (services: {
  readonly chat: ChatMessage["Service"]
  readonly queue: AutomationQueue["Service"]
  readonly homeLetterInputs: HomeLetterInputs["Service"]
  readonly home: HomeStore["Service"]
  readonly awaitRun: AwaitAutomationRun
}): AutomationRunner =>
  Effect.fn("HomeLetterRunner")(function* (
    job: AutomationJobLease
  ): Effect.fn.Return<AutomationJobResult, Error> {
    const frozen =
      job.payload.handler === SYSTEM_HANDLER.homeLetter ? job.payload.homeLetterInput : undefined
    const snapshot =
      frozen?.snapshot ?? (yield* services.home.homeLetterSnapshot(HOME_LETTER_RULES))
    const input = yield* services.homeLetterInputs.freezeHomeInput(
      job,
      frozen ?? homeLetterInput(snapshot, job.payload.prompt)
    )
    if (job.payload.chatRun === null) {
      const disposition = yield* services.home.checkHomeLetter(input.snapshot, HOME_LETTER_RULES)
      if (disposition !== HOME_LETTER_DISPOSITION.ready) {
        const [outcome, line] = UNREADY[disposition]
        return jobResult.withoutRun(outcome, line)
      }
    }
    const sessionId =
      job.payload.chatRun?.sessionId ?? (yield* services.queue.prepareRunSession(job))
    const observed = yield* runByRule(services, job, {
      sessionId,
      prompt: input.prompt,
      name: job.payload.name
    })
    const runId = observed.runId
    const run = { chatRunId: runId, chatSessionId: sessionId }
    const read = yield* readHandlerRun(services.queue, {
      observed,
      run,
      tool: HOME_LETTER_TOOL,
      schema: HomeLetterBodySchema,
      missing: "The run ended without writing a Home letter or reporting no change"
    })
    if (read.kind === HANDLER_READ.ended) return read.result
    const body = read.value
    const published = yield* services.home.publishHomeLetter({
      lease: { id: job.id, token: job.token },
      attemptId: job.payload.automationRunId,
      runId,
      snapshot: input.snapshot,
      body,
      rules: HOME_LETTER_RULES
    })
    const contentOutcome = body.paragraphs.length === 0 ? "no_change" : "finished"
    return jobResult.completed(
      published ? contentOutcome : "superseded",
      published ? "Home letter updated" : "Home evidence changed; stale letter discarded",
      run
    )
  })

export const homeLetterHandler: SystemAutomationHandler<"home_letter"> = {
  spec: {
    automationId: HOME_LETTER_AUTOMATION_ID,
    name: "Home letter",
    description: "Write a short Home letter from current work and decisions.",
    prompt: HOME_LETTER_PROMPT,
    handler: "home_letter",
    triggers: [
      { type: "time", schedule: { kind: "daily", at: "08:00", days: "daily" } },
      { type: "time", schedule: { kind: "daily", at: "18:00", days: "daily" } },
      { type: "idle", idle_minutes: 45 }
    ],
    enabled: true,
    cooldownMinutes: 180,
    toolScope: "read_only",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    promptEdit: "owner",
    triggerScope: "any",
    rearmOnSeed: false
  },
  tools: withHomeLetterTool,
  extraCapabilities: ["none"],
  run: (services) =>
    makeHomeLetterRunner({
      chat: services.chat,
      queue: services.queue,
      homeLetterInputs: services.homeLetterInputs,
      home: services.home,
      awaitRun: services.awaitRun
    })
}
