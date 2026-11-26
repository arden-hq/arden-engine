import { Effect } from "effect"
import { skillMentions } from "@arden-hq/protocol/skills"
import { loadSkillInstructions } from "../skills/instructions.js"
import type { SkillCatalog } from "../skills/service.js"
import { latestHumanText, type ContentEnvelope } from "../persistence/transcript/content.js"
import { renderPromptSection } from "../prompts/format.js"
import { SECTION_LIFETIME, type RuntimeSection } from "./runtime-update.js"

export const requestedSkillsContext = Effect.fn("Context.requestedSkills")(function* ({
  skills,
  messages
}: {
  readonly skills: SkillCatalog["Service"]
  readonly messages: ReadonlyArray<ContentEnvelope>
}): Effect.fn.Return<ReadonlyArray<RuntimeSection>> {
  const requestedSkills = [
    ...new Set(skillMentions(latestHumanText(messages) ?? "").map((mention) => mention.name))
  ]
  const prepared = yield* Effect.forEach(requestedSkills, (name) =>
    loadSkillInstructions({ skills: skills, name }).pipe(
      Effect.map(({ loaded, block }) => ({
        kind: "text" as const,
        key: `Requested Skill /${loaded.name}`,
        text: renderPromptSection(
          `Requested Skill /${loaded.name}`,
          [
            `Loaded from ${block.metadata.source}. These instructions are already available; do not call skill again to follow them. Apply them according to the user's request.`,
            block.content
          ].join("\n\n")
        ),
        lifetime: SECTION_LIFETIME.turn
      })),
      Effect.catchTag("SkillError", () => Effect.succeed(undefined))
    )
  )
  return prepared.filter((skill) => skill !== undefined)
})
