import { utcDay } from "@arden-hq/std/time"
import { Effect, Schema } from "effect"

import type { StructuredCompletion } from "../models/structured-completion.js"
import type { SummaryStore } from "../persistence/summaries/store.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { cutText } from "@arden-hq/std/text"

const OverviewSchema = Schema.Struct({
  now: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  next: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).check(
    Schema.isMaxLength(3)
  )
})

export const makeSpaceOverview = (services: {
  readonly completion: StructuredCompletion["Service"]
  readonly summaries: SummaryStore["Service"]
}) =>
  Effect.fn("Memory.spaceOverview")(function* (
    spaceId: string,
    trigger: { readonly automationRunId: number; readonly chatRunId: string }
  ) {
    const input = yield* services.summaries.overviewInput(spaceId)
    if (input === null) return false
    const systemPromptHash = sha256Hex(PROMPT_TEXT.spaceOverview)
    const userPrompt = JSON.stringify({
      space: cutText(input.spaceName, 160),
      chats: input.chats.map((chat) => ({
        chat: cutText(chat.chatName ?? chat.title, 160),
        last_active: utcDay(chat.lastActivity),
        summary: cutText(chat.summary, 400),
        topics: chat.topics.slice(0, 6).map((topic) => cutText(topic, 80))
      }))
    })
    const current = yield* services.summaries.space(spaceId)
    if (
      current?.sourceFreshness === "fresh" &&
      current.sourcesFingerprint === input.fingerprint &&
      current.systemPromptHash === systemPromptHash &&
      current.userPrompt === userPrompt
    )
      return false
    const overview = yield* services.completion.run({
      role: "helper",
      usage: { kind: "space_overview", owner: { type: "space", spaceId } },
      system: PROMPT_TEXT.spaceOverview,
      user: userPrompt,
      output: OverviewSchema,
      outputName: "space_overview",
      maxOutputTokens: 600
    })
    return yield* services.summaries.setSpace({
      spaceId,
      now: overview.now.trim(),
      next: overview.next.map((step) => step.trim()).filter(Boolean),
      recent: null,
      sourcesFingerprint: input.fingerprint,
      expectedRevisionId: current?.revisionId ?? null,
      userPrompt,
      systemPromptHash,
      triggerAutomationRunId: trigger.automationRunId,
      triggerChatRunId: trigger.chatRunId
    })
  })
