import { Effect } from "effect"
import type { ChatMessage } from "../../chat/message.js"
import type { AutomationQueue } from "../../persistence/automations/queue.js"
import { URGENT_EVENTS_AUTOMATION_ID } from "../../persistence/automations/model.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import { runByRule } from "../job-run.js"
import { ITEM_EVENT_TYPES } from "../producers/connection-item.js"
import { jobResult, type AutomationRunner, type AwaitAutomationRun } from "../runner.js"
import type { SystemAutomationHandler } from "../system-handler.js"

/**
 * The owner's rule for what needs them today, on each trigger. It is the default: the owner may
 * rewrite it, and a reset brings this text back. The check also reads the owner's profile.
 */
const NEEDS_ME_TODAY =
  "It needs me today, given who I am and what I work on: a person waits for my reply or decision, a result of something I applied for, a meeting, deadline or payment within two days, or my account is at risk. Not my own messages, newsletters, strangers' offers, sign-in codes or routine notices."

/** Starts one run for the event that woke it; the run's final reply is the alert. */
const makeUrgentEventsRunner = (services: {
  readonly chat: Pick<ChatMessage["Service"], "startAutomation">
  readonly queue: Pick<AutomationQueue["Service"], "prepareRunSession">
  readonly awaitRun: AwaitAutomationRun
}): AutomationRunner =>
  Effect.fn("UrgentEventsRunner")(function* (job) {
    const sessionId =
      job.payload.chatRun?.sessionId ?? (yield* services.queue.prepareRunSession(job))
    // The run judges by the owner's sentence, as the first check did: without it the run falls
    // back on its own, stricter sense of what is urgent.
    const rules = [
      ...new Set(job.payload.prefilter?.events.flatMap((event) => event.sentences ?? []) ?? [])
    ]
    const observed = yield* runByRule(services, job, {
      sessionId,
      prompt:
        rules.length === 0
          ? job.payload.prompt
          : `${job.payload.prompt}\n\n## The user's rule\n${rules.join("\n")}`,
      name: job.payload.name
    })
    const run = { chatRunId: observed.runId, chatSessionId: sessionId }
    return observed.status === "completed"
      ? jobResult.completed("finished", observed.result, run)
      : jobResult.failed(observed.error, observed.result, run)
  })

export const urgentEventsHandler: SystemAutomationHandler<"urgent_events"> = {
  spec: {
    automationId: URGENT_EVENTS_AUTOMATION_ID,
    name: "Urgent events",
    description:
      "Tell you at once when a mail, a notification or a calendar change needs you today.",
    prompt: PROMPT_TEXT.urgentEvents,
    handler: "urgent_events",
    // Every service whose arrivals are stored as items, so a new one is heard at once.
    triggers: Object.values(ITEM_EVENT_TYPES).map((event_type) => ({
      type: "event" as const,
      event_type,
      run_only_if: NEEDS_ME_TODAY
    })),
    enabled: true,
    cooldownMinutes: null,
    toolScope: "read_only",
    contextMode: "fresh",
    chatSession: true,
    manualRun: false,
    runsModel: true,
    rearmOnSeed: false
  },
  run: (services) =>
    makeUrgentEventsRunner({
      chat: services.chat,
      queue: services.queue,
      awaitRun: services.awaitRun
    })
}
