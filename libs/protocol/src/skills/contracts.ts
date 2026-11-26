import type { JsonRecord } from "../common/json.js"

export const SKILL_VERSION = { versioned: "versioned", unversioned: "unversioned" } as const
export const SKILL_PLACE = { builtin: "builtin", local: "local" } as const
export const SKILL_ORIGIN = { arden: "arden", shared: "shared" } as const

export type SkillOrigin = (typeof SKILL_ORIGIN)[keyof typeof SKILL_ORIGIN]

export type SkillVersion =
  | { readonly kind: typeof SKILL_VERSION.versioned; readonly version: string }
  | { readonly kind: typeof SKILL_VERSION.unversioned }

export type SkillPlace =
  | { readonly kind: typeof SKILL_PLACE.builtin; readonly invocable: boolean }
  | {
      readonly kind: typeof SKILL_PLACE.local
      readonly origin: SkillOrigin
      readonly path: string
    }

export interface Skill extends JsonRecord {
  readonly name: string
  readonly description: string
  readonly version: SkillVersion
  readonly enabled: boolean
  readonly place: SkillPlace
}

export const skillVersionText = (version: SkillVersion): string | null =>
  version.kind === SKILL_VERSION.versioned ? version.version : null

export interface SkillListResponse extends JsonRecord {
  readonly skills: ReadonlyArray<Skill>
}

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
  readonly version: SkillVersion
}

export interface SkillContent extends JsonRecord {
  readonly name: string
  readonly description: string
  readonly version: SkillVersion
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
