import { Effect } from "effect"

import type { StructuredCompletion } from "../models/structured-completion.js"
import type { AutomationCatalog } from "../persistence/automations/catalog.js"
import { PROMPTS } from "../prompts/catalog.js"
import { cutText } from "@arden-hq/std/text"
import type { AutomationId } from "../persistence/automations/model.js"
import type { Brand } from "effect/Brand"
import type { Automation } from "@arden-hq/protocol/automations"
import type { StructuredCompletionError } from "../models/structured-completion.js"
import type { AutomationStoreError } from "../persistence/automations/store.js"

const AUTOMATION_DESCRIPTION_INPUT_MAX_CHARS = 20_000

export interface AutomationDescriptionDependencies {
  readonly completion: StructuredCompletion["Service"]
  readonly store: AutomationCatalog["Service"]
}

export const makeAutomationDescription = (
  dependencies: AutomationDescriptionDependencies
): ((
  automationId: string & Brand<"AutomationId">
) => Effect.Effect<
  Automation | undefined,
  StructuredCompletionError | AutomationStoreError,
  never
>) =>
  Effect.fn("AutomationDescription.generate")(function* (automationId: AutomationId) {
    const automation = yield* dependencies.store.get(automationId)
    if (automation === null) return undefined
    if (automation.description.kind === "manual") {
      return automation
    }
    const description = yield* dependencies.completion.runText({
      role: "helper",
      usage: { kind: "automation_description", owner: { type: "none" } },
      system: PROMPTS.automationDescription,
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
