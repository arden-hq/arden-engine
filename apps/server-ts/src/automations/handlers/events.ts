import { ITEM_EVENTS } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { ChatMessage } from "../../chat/message.js"
import type { AutomationQueue } from "../../persistence/automations/queue.js"
import { EVENTS_AUTOMATION_ID } from "../../persistence/automations/model.js"
import type { PostStore } from "../../persistence/posts/store.js"
import { PROMPTS } from "../../prompts/catalog.js"
import { readHandlerRun } from "../handler-tool-result.js"
import { runByRule } from "../job-run.js"
import {
  POST_MESSAGE_TOOL,
  PostMessageInputSchema,
  withPostMessageTool
} from "../post-message-tool.js"
import { jobResult, type AutomationRunner, type AwaitAutomationRun } from "../runner.js"
import type { SystemAutomationHandler } from "../system-handler.js"

const DEFAULT_RULE =
  "Something I'd want to know about or act on. Not newsletters, receipts or routine notices."

export const makeEventsRunner = (services: {
  readonly chat: Pick<ChatMessage["Service"], "startAutomation">
  readonly queue: Pick<AutomationQueue["Service"], "prepareRunSession" | "handlerToolResult">
  readonly posts: Pick<PostStore["Service"], "post">
  readonly awaitRun: AwaitAutomationRun
}): AutomationRunner =>
  Effect.fn("EventsRunner")(function* (job) {
    const itemIds = job.payload.handler === "events" ? job.payload.itemIds : []
    if (itemIds.length === 0) return jobResult.withoutRun("no_input", "Nothing arrived to check")
    const sessionId =
      job.payload.chatRun?.sessionId ?? (yield* services.queue.prepareRunSession(job))
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
    const read = yield* readHandlerRun(services.queue, {
      observed,
      run,
      tool: POST_MESSAGE_TOOL,
      schema: PostMessageInputSchema,
      missing: "The run ended without posting a message or reporting no change"
    })
    if (read.kind === "ended") return read.result
    const post = read.value
    yield* services.posts.post({
      automationId: job.payload.automationId,
      attemptId: job.payload.automationRunId,
      lease: { id: job.id, token: job.token },
      runId: observed.runId,
      spaceId: post.space_id,
      text: post.text,
      task: post.task,
      itemIds
    })
    return jobResult.completed("finished", post.text, run)
  })

export const eventsHandler: SystemAutomationHandler<"events"> = {
  spec: {
    automationId: EVENTS_AUTOMATION_ID,
    name: "Events",
    description:
      "Post in the right Space when a mail, a notification or a calendar change matters to you.",
    prompt: PROMPTS.events,
    handler: "events",
    triggers: ITEM_EVENTS.map((event_type) => ({
      type: "event" as const,
      event_type,
      run_only_if: { kind: "sentence" as const, sentence: DEFAULT_RULE },
      condition: { kind: "none" as const }
    })),
    enabled: true,
    cooldownMinutes: null,
    toolScope: "read_only",
    contextMode: "fresh",
    chatSession: true,
    manualRun: false,
    promptEdit: "fixed",
    triggerScope: "item_events",
    rearmOnSeed: false
  },
  tools: withPostMessageTool,
  run: (services) =>
    makeEventsRunner({
      chat: services.chat,
      queue: services.queue,
      posts: services.posts,
      awaitRun: services.awaitRun
    })
}
