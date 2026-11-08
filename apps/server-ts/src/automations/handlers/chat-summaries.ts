import { Effect } from "effect"
import type { ChatMessage } from "../../chat/message.js"
import { AutomationId } from "../../persistence/automations/model.js"
import type { AutomationQueue } from "../../persistence/automations/queue.js"
import type {
  AutomationJobLease,
  AutomationJobResult
} from "../../persistence/automations/store.js"
import type { SummaryStore } from "../../persistence/summaries/store.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import {
  jobResult,
  startAutomationRun,
  type AutomationRunner,
  type AwaitAutomationRun
} from "../runner.js"
import type { SystemAutomationHandler, SystemHandlerServices } from "../system-handler.js"

const CHAT_SUMMARIES_AUTOMATION_ID = AutomationId.make("builtin-chat-summaries")

const currentSummaryText = (
  summary: {
    readonly title: string
    readonly summary: string
    readonly topics: ReadonlyArray<string>
  } | null
): string =>
  summary === null
    ? "## Current summary\nNone yet: this chat has not been summarized."
    : [
        "## Current summary",
        `Title: ${summary.title}`,
        `Summary: ${summary.summary}`,
        `Topics: ${summary.topics.join("; ") || "none"}`
      ].join("\n")

const makeChatSummariesRunner = (services: {
  readonly chat: ChatMessage["Service"]
  readonly queue: AutomationQueue["Service"]
  readonly summaries: SummaryStore["Service"]
  readonly spaceOverview: SystemHandlerServices["spaceOverview"]
  readonly linkOfferChat: SystemHandlerServices["linkOfferChat"]
  readonly awaitRun: AwaitAutomationRun
}): AutomationRunner =>
  Effect.fn("ChatSummariesRunner")(function* (
    job: AutomationJobLease
  ): Effect.fn.Return<AutomationJobResult, Error> {
    const fork = yield* services.queue.prepareForkSession(job)
    if (fork === null) return jobResult.withoutRun("no_input", "No chat to summarize")
    const sessionId = fork.sessionId
    let runId = job.payload.chatRun?.runId ?? null
    if (runId === null) {
      const current = yield* services.summaries.chat(fork.sourceSessionId)
      const receipt = yield* startAutomationRun(services.chat, job, {
        sessionId,
        clientId: `automation-run-${job.payload.automationRunId}`,
        prompt: `${job.payload.prompt}\n\n${currentSummaryText(current)}`,
        name: job.payload.name
      })
      if (receipt.runId === null) throw new Error("Chat summary has no Run identity")
      runId = receipt.runId
    }
    const run = { chatRunId: runId, chatSessionId: sessionId }
    const observed = yield* services.awaitRun(runId)
    if (observed.status !== "completed")
      return jobResult.failed(observed.error, observed.result, run)
    const saved = yield* services.summaries.chat(fork.sourceSessionId)
    if (saved?.runId !== runId) {
      return jobResult.completed("no_change", "Nothing to recall in this chat", run)
    }
    if (saved.spaceId !== null) {
      yield* services
        .spaceOverview(saved.spaceId, {
          automationRunId: job.payload.automationRunId,
          chatRunId: runId
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("Space overview not updated", cause)))
    }
    yield* services
      .linkOfferChat({
        sessionId: fork.sourceSessionId,
        spaceId: saved.spaceId,
        title: saved.title,
        summary: saved.summary,
        throughSequence: saved.throughSequence
      })
      .pipe(Effect.catchCause((cause) => Effect.logWarning("Offer match not made", cause)))
    return jobResult.completed("finished", "Chat summary saved", run)
  })

export const chatSummariesHandler: SystemAutomationHandler<"chat_summaries"> = {
  spec: {
    automationId: CHAT_SUMMARIES_AUTOMATION_ID,
    name: "Chat summaries",
    description: "Keep a short summary of each chat, so Arden can link back to it later.",
    prompt: PROMPT_TEXT.chatSummary,
    handler: "chat_summaries",
    triggers: [
      {
        type: "event",
        event_type: "chat.quiet",
        condition: { kind: "compare", field: "chat.your_messages", op: "gte", value: 1 }
      },
      { type: "count", every_n: 25 }
    ],
    enabled: true,
    cooldownMinutes: null,
    toolScope: "chat_summary",
    contextMode: "fork",
    chatSession: false,
    manualRun: false,
    runsModel: true,
    rearmOnSeed: false
  },
  run: (services) =>
    makeChatSummariesRunner({
      chat: services.chat,
      queue: services.queue,
      summaries: services.summaries,
      spaceOverview: services.spaceOverview,
      linkOfferChat: services.linkOfferChat,
      awaitRun: services.awaitRun
    })
}
