import {
  SkillDescriptionSchema,
  SkillNameSchema,
  SkillVersionSchema
} from "@arden-hq/protocol/effect/skills"
import { SKILL_VERSION, type SkillVersion } from "@arden-hq/protocol/skills"
import { Effect, Schema } from "effect"
import { parseDocument } from "yaml"

import { skillError, type SkillOperation } from "./errors.js"

export const declaredVersion = (version: string | undefined): SkillVersion =>
  version === undefined
    ? { kind: SKILL_VERSION.unversioned }
    : { kind: SKILL_VERSION.versioned, version }

const ToolGroupSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))

const isName = Schema.is(SkillNameSchema)
const isDescription = Schema.is(SkillDescriptionSchema)
const isVersion = Schema.is(SkillVersionSchema)
const isToolGroup = Schema.is(ToolGroupSchema)

export interface SkillMetadata {
  readonly [field: string]: unknown
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly tool_group?: string
  readonly user_invocable?: boolean
  readonly metadata?: unknown
}

const CHECKED_OPTIONAL_FIELDS: ReadonlySet<string> = new Set([
  "version",
  "tool_group",
  "user_invocable"
])

const versionOf = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return `${value}.0.0`
  if (typeof value !== "string") return undefined
  const parts = value.trim().replace(/^v/, "").split(".")
  const full = [...parts, "0", "0"].slice(0, 3).join(".")
  return parts.length <= 3 && isVersion(full) ? full : undefined
}

const optionalFields = (
  record: Readonly<Record<string, unknown>>
): Pick<SkillMetadata, "version" | "tool_group" | "user_invocable"> => {
  const version = versionOf(record["version"])
  const toolGroup = record["tool_group"]
  const userInvocable = record["user_invocable"]
  return {
    ...(version === undefined ? {} : { version }),
    ...(isToolGroup(toolGroup) ? { tool_group: toolGroup } : {}),
    ...(typeof userInvocable === "boolean" ? { user_invocable: userInvocable } : {})
  }
}

export const parseSkillMetadata = Effect.fn("Skills.parseMetadata")(function* (
  source: string,
  /** The folder the Skill must be named after; null when the folder name is free. */
  directoryName: string | null,
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
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return yield* skillError(operation, "invalid", "Skill metadata is not a mapping")
  const record: Readonly<Record<string, unknown>> = { ...value }
  const name = record["name"]
  const description = record["description"]
  if (!isName(name))
    return yield* skillError(operation, "invalid", "Skill metadata `name` is missing or invalid")
  if (!isDescription(description))
    return yield* skillError(
      operation,
      "invalid",
      "Skill metadata `description` is missing or invalid"
    )
  const rest = Object.fromEntries(
    Object.entries(record).filter(([field]) => !CHECKED_OPTIONAL_FIELDS.has(field))
  )
  const metadata: SkillMetadata = { ...rest, name, description, ...optionalFields(record) }
  if (directoryName !== null && metadata.name !== directoryName) {
    return yield* skillError(operation, "invalid", "Skill name does not match its directory")
  }
  return metadata
})
