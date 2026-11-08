import type { JsonRecord } from "../common/json.js"

/** A Skill the user sends instead of one Arden loads: its body is a prompt, and
 *  `{name}` spans in it are blanks the user fills in the composer. */
export interface SkillRecipe extends JsonRecord {
  readonly title: string
  readonly prompt: string
  /** The Space whose new chats offer it first; null offers it everywhere. */
  readonly space_id: string | null
}

/** What "Generate recipe" sends: the message the user wants to reuse. */
export interface SkillRecipeDraftRequest extends JsonRecord {
  readonly text: string
}

/** The Helper's draft of a Recipe from a message: a title, and the message with
 *  what changes between uses swapped for `{name}` blanks. Nothing is saved yet. */
export interface SkillRecipeDraft extends JsonRecord {
  readonly title: string
  readonly prompt: string
}

/** One locally installed skill. Filesystem details stay server-owned. */
export interface Skill extends JsonRecord {
  readonly name: string
  readonly description: string
  /** Human-authored semantic version. Exact loaded bytes remain identified by SHA-256. */
  readonly version: string | null
  readonly enabled: boolean
  /** Ships with the app: a built-in Skill (always enabled) or a starter Recipe (the user may hide it). Never removable. */
  readonly builtin: boolean
  /** A built-in Skill the user may also call from the / menu. Local Skills always can. */
  readonly invocable?: true
  /** Where a local Skill lives: Arden's own folder, or a root shared with other agents
   *  (removable only there). Absent on built-ins. */
  readonly origin?: "arden" | "shared"
  /** The Skill's directory as discovered, so the user can find and edit it. Absent on built-ins. */
  readonly path?: string
  /** Present when this Skill is a Recipe. The model's Skills list never includes one. */
  readonly recipe: SkillRecipe | null
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
