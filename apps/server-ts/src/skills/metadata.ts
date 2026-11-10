import {
  SkillDescriptionSchema,
  SkillNameSchema,
  SkillVersionSchema
} from "@arden-hq/protocol/effect/skills"
import { Effect, Schema } from "effect"
import { parseDocument } from "yaml"

import { skillError, type SkillOperation } from "./errors.js"

const SkillMetadataSchema = Schema.Struct({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  version: Schema.optionalKey(SkillVersionSchema),
  tool_group: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
  ),
  user_invocable: Schema.optionalKey(Schema.Boolean),
  metadata: Schema.optionalKey(Schema.Unknown)
})

export const parseSkillMetadata = Effect.fn("Skills.parseMetadata")(function* (
  source: string,
  directoryName: string,
  operation: SkillOperation
) {
  // A SKILL.md saved with Windows line endings is the same Skill.
  const lines = source.split("\n").map((line) => line.replace(/\r$/, ""))
  if (lines[0] !== "---") {
    return yield* skillError(operation, "invalid", "Skill metadata is missing")
  }

  const closing = lines.findIndex((line, index) => index > 0 && line === "---")
  if (closing < 0) return yield* skillError(operation, "invalid", "Skill metadata is incomplete")

  const value = yield* Effect.try({
    try: () => {
      const document = parseDocument(lines.slice(1, closing).join("\n"), {
        schema: "core",
        strict: true,
        stringKeys: true,
        uniqueKeys: true
      })
      if (document.errors.length > 0) throw new Error("Invalid YAML frontmatter")
      return document.toJS({ maxAliasCount: 0 }) as unknown
    },
    catch: (cause) => skillError(operation, "invalid", "Skill metadata is invalid", cause)
  })
  const metadata = yield* Schema.decodeUnknownEffect(SkillMetadataSchema)(value, {
    onExcessProperty: "preserve"
  }).pipe(
    Effect.mapError((cause) => skillError(operation, "invalid", "Skill metadata is invalid", cause))
  )
  if (metadata.name !== directoryName) {
    return yield* skillError(operation, "invalid", "Skill name does not match its directory")
  }
  return metadata
})
