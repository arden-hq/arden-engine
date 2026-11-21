import type { JsonRecord } from "../common/json.js"

/** One locally installed skill. Filesystem details stay server-owned. */
export interface Skill extends JsonRecord {
  readonly name: string
  readonly description: string
  /** Human-authored semantic version. Exact loaded bytes remain identified by SHA-256. */
  readonly version: string | null
  readonly enabled: boolean
  /** Ships with the app: a built-in Skill (always enabled). Never removable. */
  readonly builtin: boolean
  /** A built-in Skill the user may also call from the / menu. Local Skills always can. */
  readonly invocable?: true
  /** Where a local Skill lives: Arden's own folder, or a root shared with other agents
   *  (removable only there). Absent on built-ins. */
  readonly origin?: "arden" | "shared"
  /** The Skill's directory as discovered, so the user can find and edit it. Absent on built-ins. */
  readonly path?: string
}

export interface SkillListResponse extends JsonRecord {
  readonly skills: ReadonlyArray<Skill>
}

/** One installable skill from the server-owned marketplace catalog. */
export interface MarketplaceSkill extends JsonRecord {
  readonly id: string
  readonly name: string
  readonly author: string
  readonly source: string
  readonly installs: number
  readonly url: string
  readonly installed: boolean
}

export interface MarketplaceSkillListResponse extends JsonRecord {
  readonly skills: ReadonlyArray<MarketplaceSkill>
}

export interface MarketplaceSkillInstallInput extends JsonRecord {
  readonly id: string
}

export interface SkillInstallReceipt extends JsonRecord {
  readonly status: "installed"
  readonly name: string
  readonly description: string
  readonly version: string | null
}

/** Markdown content for a skill. The server owns the source file location. */
export interface SkillContent extends JsonRecord {
  readonly name: string
  readonly description: string
  readonly version: string | null
  readonly content: string
}

export interface SkillToggleReceipt extends JsonRecord {
  readonly name: string
  readonly enabled: boolean
}

export interface SkillRemoveReceipt extends JsonRecord {
  readonly status: "removed"
  readonly name: string
}
