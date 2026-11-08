import { Effect, Schema } from "effect"

import type { StructuredCompletion } from "../models/structured-completion.js"
import type { SpaceStore } from "../persistence/spaces/store.js"
import type { TaskProposalStore } from "../persistence/proposals/store.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { clean, loadOfferSpaces, renderOfferSpaces } from "./candidates.js"

const OutcomeAnswerSchema = Schema.Struct({
  offers: Schema.Array(
    Schema.String.annotate({ description: 'An open offer id such as "o3", exactly as listed.' })
  )
})

type OutcomeAnswer = (typeof OutcomeAnswerSchema)["Type"]

const decideOutcomeSpaces = (
  answer: OutcomeAnswer,
  listed: ReadonlyArray<{ readonly id: string; readonly spaceId: string }>
): ReadonlyArray<string> => [
  ...new Set(
    answer.offers.flatMap((id) => listed.find((offer) => offer.id === id.trim())?.spaceId ?? [])
  )
]

export interface ChatOutcomeDependencies {
  readonly spaces: SpaceStore["Service"]
  readonly proposals: TaskProposalStore["Service"]
  readonly completion: StructuredCompletion["Service"]
}

export const makeChatOutcomeLinker = (dependencies: ChatOutcomeDependencies) =>
  Effect.fn("ChatOutcomeRouter.link")(function* (chat: {
    readonly sessionId: string
    readonly spaceId: string | null
    readonly title: string
    readonly summary: string
    readonly throughSequence: number
  }) {
    const others = (yield* dependencies.spaces.list()).filter(
      (space) =>
        space.space_id !== chat.spaceId && space.archived_at === null && space.inference.enabled
    )
    const unlinked = new Set(
      yield* dependencies.spaces.unlinkedSpaces(
        chat.sessionId,
        chat.throughSequence,
        others.map((space) => space.space_id)
      )
    )
    const spaces = yield* loadOfferSpaces(
      dependencies.proposals,
      others.filter((space) => unlinked.has(space.space_id))
    )
    if (spaces.length === 0) return
    const listing = renderOfferSpaces(spaces)
    const answer = yield* dependencies.completion.runTool({
      role: "helper",
      usage: { kind: "item_routing", owner: { type: "none" } },
      system: PROMPT_TEXT.chatOutcomeRouter,
      user: [
        "Spaces:",
        listing.text,
        "",
        "The finished chat:",
        clean(`${chat.title}: ${chat.summary}`)
      ].join("\n"),
      maxOutputTokens: 300,
      result: {
        schema: OutcomeAnswerSchema,
        name: "route_chat_outcome",
        displayName: "Route Chat Outcome",
        description: "Say which open offers the finished chat may have completed, if any."
      }
    })
    for (const spaceId of decideOutcomeSpaces(answer, listing.ids))
      yield* dependencies.spaces.linkChat(spaceId, chat.sessionId, chat.throughSequence)
  })
