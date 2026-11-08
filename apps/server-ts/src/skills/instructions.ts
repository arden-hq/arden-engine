import { Effect } from "effect"
import { sha256Hex } from "@arden-hq/std/hash"
import type { SkillCatalog } from "./service.js"
import { SkillError } from "./errors.js"
import { BUILT_IN_SKILL_SOURCE, LOCAL_SKILL_SOURCE, TRUSTED_SKILL_CONTENT_TYPE } from "./guard.js"

export const loadSkillInstructions = Effect.fn("Skills.loadInstructions")(function* ({
  skills,
  name,
  resource
}: {
  readonly skills: SkillCatalog["Service"]
  readonly name: string
  readonly resource?: string
}) {
  const loaded = yield* skills.load(name)
  if (!loaded.enabled)
    return yield* new SkillError({
      operation: "content",
      reason: "not_found",
      message: "Skill is not enabled"
    })
  const content = resource === undefined ? loaded.content : yield* skills.reference(name, resource)
  const sha256 = sha256Hex(content)
  return {
    loaded,
    sha256,
    block: {
      type: "context" as const,
      content_type: TRUSTED_SKILL_CONTENT_TYPE,
      content:
        loaded.directory === null
          ? content.trim()
          : [
              content.trim(),
              "",
              `Base directory for this Skill: ${loaded.directory}`,
              "Resolve relative paths in the Skill against this directory. Read linked Markdown references with skill(name, resource), including inside code agents."
            ].join("\n"),
      metadata: {
        source: loaded.builtin ? BUILT_IN_SKILL_SOURCE : LOCAL_SKILL_SOURCE,
        skill_name: loaded.name,
        ...(loaded.version === null ? {} : { skill_version: loaded.version }),
        ...(resource === undefined ? {} : { skill_resource: resource }),
        source_sha256: sha256
      }
    }
  }
})
