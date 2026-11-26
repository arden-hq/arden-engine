import { SKILL_PLACE, SKILL_VERSION, type Skill } from "@arden-hq/protocol/skills"
import type { SkillLoadedContent } from "./service.js"
import { catalogSignatures } from "@arden-hq/answer-ui"
import { compilePromptTemplate, renderPromptTemplate } from "@arden-hq/prompt-template"
import { Effect } from "effect"

import { readAuthoredFile } from "../prompts/catalog.js"
import { parseSkillMetadata } from "./metadata.js"
import { type SkillError, skillError, type SkillOperation } from "./errors.js"

export interface BuiltInSkill {
  readonly name: BuiltInSkillName
  readonly description: string
  readonly version: string
  readonly toolGroup: string
  readonly userInvocable: boolean
  readonly content: string
}

const BUILT_IN_SKILL_NAMES = [
  "gmail",
  "calendar",
  "drive",
  "browser",
  "computer-use",
  "github",
  "apple-apps",
  "google-setup",
  "space-work",
  "arden-internals",
  "automation-design",
  "work-coordination",
  "fan-out",
  "visualize",
  "inline-components",
  "skill-creator"
] as const

type BuiltInSkillName = (typeof BUILT_IN_SKILL_NAMES)[number]

const SKILL_SLOT_VALUES: Partial<Record<BuiltInSkillName, Readonly<Record<string, string>>>> = {
  "inline-components": { component_catalog: catalogSignatures() }
}

const fillSlots = (name: BuiltInSkillName, source: string): string => {
  const values = SKILL_SLOT_VALUES[name]
  if (values === undefined) return source
  const template = compilePromptTemplate({ source })
  const declared = Object.keys(values)
  if (
    template.slots.length !== declared.length ||
    !template.slots.every((slot) => declared.includes(slot))
  ) {
    throw new Error(
      `Built-in Skill '${name}' slots [${template.slots.join(", ")}] do not match its values [${declared.join(", ")}].`
    )
  }
  return renderPromptTemplate({ template, values })
}

const readBuiltInSkill = (name: BuiltInSkillName): BuiltInSkill => {
  const content = fillSlots(name, readAuthoredFile(`skills/${name}/SKILL.md`))
  const metadata = Effect.runSync(
    parseSkillMetadata(content, name, "content").pipe(
      Effect.mapError((error) => new Error(`Built-in Skill '${name}' is invalid: ${error.message}`))
    )
  )
  if (metadata.version === undefined) {
    throw new Error(`Built-in Skill '${name}' must declare a version.`)
  }
  if (metadata.tool_group === undefined) {
    throw new Error(`Built-in Skill '${name}' must name its tool group.`)
  }
  return Object.freeze({
    name,
    description: metadata.description,
    version: metadata.version,
    toolGroup: metadata.tool_group,
    userInvocable: metadata.user_invocable === true,
    content
  })
}

/** Skills for a Mac program are left out elsewhere. */
const MAC_ONLY: ReadonlySet<BuiltInSkillName> = new Set(["apple-apps"])

export const BUILT_IN_SKILLS: ReadonlyArray<BuiltInSkill> = Object.freeze(
  BUILT_IN_SKILL_NAMES.filter((name) => process.platform === "darwin" || !MAC_ONLY.has(name)).map(
    readBuiltInSkill
  )
)

const byName = new Map<string, BuiltInSkill>(BUILT_IN_SKILLS.map((skill) => [skill.name, skill]))

export const builtInSkillByName = (name: string): BuiltInSkill | undefined => byName.get(name)

export const isBuiltInSkillName = (name: string): boolean => byName.has(name)

export const reservedName = (operation: SkillOperation, name: string): SkillError =>
  skillError(operation, "invalid", `Skill name ${name} is reserved for a built-in Skill`)

export const builtInUnchangeable = (operation: SkillOperation, name: string): SkillError =>
  skillError(operation, "invalid", `Skill ${name} is built in and cannot be changed`)

const builtInSkill = (skill: BuiltInSkill): Skill => ({
  name: skill.name,
  description: skill.description,
  version: { kind: SKILL_VERSION.versioned, version: skill.version },
  enabled: true,
  place: { kind: SKILL_PLACE.builtin, invocable: skill.userInvocable }
})

export const builtInLoaded = (skill: BuiltInSkill): SkillLoadedContent => ({
  name: skill.name,
  description: skill.description,
  version: { kind: SKILL_VERSION.versioned, version: skill.version },
  content: skill.content,
  directory: null,
  builtin: true,
  enabled: true
})

export const BUILT_IN_LIST: ReadonlyArray<Skill> = BUILT_IN_SKILLS.map(builtInSkill)
