import { Effect, Schema } from "effect"
import { HomeLetterBodySchema } from "@arden-hq/protocol/effect/runs"
import type { ChatMessage } from "../../chat/message.js"
import type { AutomationQueue } from "../../persistence/automations/queue.js"
import type {
  AutomationJobLease,
  AutomationJobResult
} from "../../persistence/automations/store.js"
import type { HomeLetterInputs } from "../../persistence/automations/home-letter-inputs.js"
import type { HomeStore } from "../../persistence/home/store.js"
import { HOME_LETTER_AUTOMATION_ID } from "../../persistence/automations/model.js"
import { HOME_LETTER_PROMPT, HOME_LETTER_RULES, homeLetterInput } from "../home-letter-prompt.js"
import { withHomeLetterTool } from "../home-letter-tool.js"
import {
  jobResult,
  startAutomationRun,
  type AutomationRunner,
  type AwaitAutomationRun
} from "../runner.js"
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
    const frozen = job.payload.handler === "home_letter" ? job.payload.homeLetterInput : undefined
    const snapshot =
      frozen?.snapshot ?? (yield* services.home.homeLetterSnapshot(HOME_LETTER_RULES))
    const input = yield* services.homeLetterInputs.freezeHomeInput(
      job,
      frozen ?? homeLetterInput(snapshot, job.payload.prompt)
    )
    if (job.payload.chatRun === null) {
      const disposition = yield* services.home.checkHomeLetter(input.snapshot, HOME_LETTER_RULES)
      if (disposition !== "ready") {
        const [outcome, line] = UNREADY[disposition]
        return jobResult.withoutRun(outcome, line)
      }
    }
    const sessionId =
      job.payload.chatRun?.sessionId ?? (yield* services.queue.prepareRunSession(job))
    let runId = job.payload.chatRun?.runId ?? null
    if (runId === null) {
      const receipt = yield* startAutomationRun(services.chat, job, {
        sessionId,
        clientId: `automation-run-${job.payload.automationRunId}`,
        prompt: input.prompt,
        name: job.payload.name
      })
      if (receipt.runId === null) throw new Error("Home Worker has no Run identity")
      runId = receipt.runId
    }
    const run = { chatRunId: runId, chatSessionId: sessionId }
    const observed = yield* services.awaitRun(runId)
    if (observed.status !== "completed")
      return jobResult.failed(observed.error, observed.result, run)
    const decoded: unknown = JSON.parse(observed.result ?? "null")
    const body = yield* Schema.decodeUnknownEffect(HomeLetterBodySchema)(decoded)
    const published = yield* services.home.publishHomeLetter({
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
      { type: "time", at: "08:00", days: "daily" },
      { type: "time", at: "18:00", days: "daily" },
      { type: "idle", idle_minutes: 45 }
    ],
    enabled: true,
    cooldownMinutes: 180,
    toolScope: "read_only",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    runsModel: true,
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
