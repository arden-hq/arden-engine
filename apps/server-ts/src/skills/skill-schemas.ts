import { isRelativePathSegment } from "@arden-hq/protocol/common"
import { SKILL_FILE_NAME } from "./names.js"
import type { SkillContent } from "@arden-hq/protocol/skills"
import { type SkillVersion } from "@arden-hq/protocol/skills"
import { Schema } from "effect"

export const SKILL_FILE: typeof SKILL_FILE_NAME.skill = SKILL_FILE_NAME.skill
export const DISABLED_FILE: typeof SKILL_FILE_NAME.disabled = SKILL_FILE_NAME.disabled
export const MAX_SKILL_BYTES = 512 * 1024
export const MAX_CATALOG_CHARS = 32_000
const MAX_RESOURCE_FILES = 128
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024
const MAX_RESOURCES_BYTES = 10 * 1024 * 1024

const SkillResourcePathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => {
    const parts = value.split("/")
    if (value.startsWith("/") || value.includes("\\") || parts.length > 8) {
      return "must be a shallow relative path"
    }
    if (/[\u0000-\u001f\u007f]/u.test(value)) return "must not contain control characters"
    if (parts.some((part) => part.length === 0 || isRelativePathSegment(part))) {
      return "must not contain empty or traversing path components"
    }
    return ["scripts", "references", "assets"].includes(parts[0] ?? "") && parts.length > 1
      ? undefined
      : "must be inside scripts, references, or assets"
  })
)

const SkillResourceFileSchema = Schema.Struct({
  path: SkillResourcePathSchema,
  content: Schema.String.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).byteLength <= MAX_RESOURCE_BYTES
        ? undefined
        : `must be at most ${MAX_RESOURCE_BYTES} bytes as UTF-8`
    )
  ),
  executable: Schema.Boolean
}).check(
  Schema.makeFilter((file) =>
    file.executable && !file.path.startsWith("scripts/")
      ? { path: ["executable"], issue: "may be true only for scripts" }
      : undefined
  )
)

export const SkillResourceFilesSchema = Schema.Array(SkillResourceFileSchema).check(
  Schema.makeFilter((files) => {
    if (files.length > MAX_RESOURCE_FILES) {
      return `must contain at most ${MAX_RESOURCE_FILES} files`
    }
    const paths = new Set(files.map((file) => file.path))
    if (paths.size !== files.length) return "must not contain duplicate paths"
    const bytes = files.reduce(
      (total, file) => total + new TextEncoder().encode(file.content).byteLength,
      0
    )
    return bytes <= MAX_RESOURCES_BYTES
      ? undefined
      : `must total at most ${MAX_RESOURCES_BYTES} bytes as UTF-8`
  })
)

export interface SkillRecord {
  readonly skill: {
    readonly name: string
    readonly description: string
    readonly version: SkillVersion
    readonly enabled: boolean
  }
  readonly content: string
  readonly directory: string
  readonly identity: string
  readonly root: string
}

export interface SkillRoots {
  readonly primary: string | null
  readonly extra: ReadonlyArray<string>
}

export interface SkillLoadedContent extends SkillContent {
  readonly directory: string | null
  readonly builtin: boolean
  readonly enabled: boolean
}

export interface SkillCatalogPromptOptions {
  readonly omit?: ReadonlySet<string>
}

export interface SkillCreateInput {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly version?: string
  readonly files?: ReadonlyArray<{
    readonly path: string
    readonly content: string
    readonly executable: boolean
  }>
}
