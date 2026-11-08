import type { SkillRecipeDraft } from "@arden-hq/protocol/skills"
import { Effect, Schema } from "effect"

import type { StructuredCompletion } from "../models/structured-completion.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"

const TITLE_MAX_CHARS = 80

const DraftOutputSchema = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String
})

export interface RecipeDraftDependencies {
  readonly completion: StructuredCompletion["Service"]
}

export const makeRecipeDraft = (dependencies: RecipeDraftDependencies) =>
  Effect.fn("RecipeDraft.generate")(function* (text: string) {
    const draft = yield* dependencies.completion.run({
      role: "helper",
      usage: { kind: "recipe_draft", owner: { type: "none" } },
      system: PROMPT_TEXT.recipeDraft,
      user: JSON.stringify({ message: text }),
      output: DraftOutputSchema,
      outputName: "recipe_draft",
      maxOutputTokens: 256 + Math.ceil(text.length / 2)
    })
    return normalizeDraft(draft, text)
  })

const normalizeDraft = (
  draft: { readonly title: string; readonly prompt: string },
  text: string
): SkillRecipeDraft => {
  const title = draft.title.trim().replace(/\.+$/, "").slice(0, TITLE_MAX_CHARS).trim()
  const prompt = draft.prompt.trim()
  return {
    title: title === "" ? "Recipe" : title,
    prompt: prompt === "" ? text.trim() : prompt
  }
}
