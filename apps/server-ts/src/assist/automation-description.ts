import { Effect } from "effect"

import type { StructuredCompletion } from "../models/structured-completion.js"
import type { AutomationCatalog } from "../persistence/automations/catalog.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { cutText } from "@arden-hq/std/text"
import type { AutomationId } from "../persistence/automations/model.js"

const AUTOMATION_DESCRIPTION_INPUT_MAX_CHARS = 20_000

export interface AutomationDescriptionDependencies {
  readonly completion: StructuredCompletion["Service"]
  readonly store: AutomationCatalog["Service"]
}

export const makeAutomationDescription = (dependencies: AutomationDescriptionDependencies) =>
  Effect.fn("AutomationDescription.generate")(function* (automationId: AutomationId) {
    const automation = yield* dependencies.store.get(automationId)
    if (automation === null) return undefined
    if (automation.description_source === "manual" && automation.description !== null) {
      return automation
    }
    const description = yield* dependencies.completion.runText({
      role: "helper",
      usage: { kind: "automation_description", owner: { type: "none" } },
      system: PROMPT_TEXT.automationDescription,
      user: JSON.stringify({
        title: automation.name,
        instructions: cutText(automation.prompt, AUTOMATION_DESCRIPTION_INPUT_MAX_CHARS)
      }),
      maxOutputTokens: 128,
      maxCharacters: 220
    })
    return (
      (yield* dependencies.store.setGeneratedDescription(automationId, description)) ?? undefined
    )
  })
