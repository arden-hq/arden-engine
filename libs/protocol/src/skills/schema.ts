import { Effect, Schema } from "effect"
import {
  SKILL_PLACE,
  SKILL_VERSION,
  type MarketplaceSkillListResponse,
  type Skill,
  type SkillContent,
  type SkillInstallReceipt,
  type SkillListResponse,
  type SkillRemoveReceipt,
  type SkillToggleReceipt
} from "./contracts.js"
import { NonNegativeIntSchema } from "../common/schema.js"
import { splitMarketplaceSkillId, type MarketplaceSkillAddress } from "./marketplace-id.js"

const strict = { onExcessProperty: "error" } as const
const skillsCollectionPath = "/skills"

/** One spelling for a Skill name: lowercase letters, digits, hyphens and
 *  underscores, not starting with a hyphen, up to 64 characters. It is a folder
 *  name and a URL segment, so no dot, slash or space. Wider than Arden's own
 *  Skills need, so that Skills written for other harnesses load too. */
export const SKILL_NAME_PATTERN = "[a-z0-9_][a-z0-9_-]{0,63}"

export const SkillNameSchema = Schema.String.check(
  Schema.isPattern(new RegExp(`^${SKILL_NAME_PATTERN}$`))
)

export const SkillVersionSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
)

export const MarketplaceSkillSourceSchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(140),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/i)
)

export const MarketplaceSkillAuthorSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(39),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38})$/i)
)

const isMarketplaceSkillSource = Schema.is(MarketplaceSkillSourceSchema)
const isSkillName = Schema.is(SkillNameSchema)

export const MarketplaceSkillIdSchema = Schema.String.check(
  Schema.isMinLength(5),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => {
    const address = splitMarketplaceSkillId(value)
    if (address === undefined) return "must contain a source and skill name"
    return isMarketplaceSkillSource(address.source) && isSkillName(address.name)
      ? undefined
      : "must be a GitHub owner/repository/skill ID"
  })
)

const isMarketplaceSkillId = Schema.is(MarketplaceSkillIdSchema)

export const readMarketplaceSkillId = (value: string): MarketplaceSkillAddress | undefined =>
  isMarketplaceSkillId(value) ? splitMarketplaceSkillId(value) : undefined

export const MarketplaceSkillSearchTextSchema = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => (value === value.trim() ? undefined : "must be trimmed"))
)

export const MarketplaceSkillSearchQuerySchema = Schema.Struct({
  q: MarketplaceSkillSearchTextSchema
})

export const SkillMarketplaceUrlSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^https:\/\/skills\.sh\//)
)

export const SkillDescriptionSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096)
)

export const SkillContentBodySchema = Schema.String.check(
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).byteLength <= 512 * 1024
      ? undefined
      : "must be at most 512 KiB as UTF-8"
  )
)

const SkillVersionStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(SKILL_VERSION.versioned), version: SkillVersionSchema }),
  Schema.Struct({ kind: Schema.Literal(SKILL_VERSION.unversioned) })
])

export const SkillSchema: Schema.Codec<Skill> = Schema.Struct({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  version: SkillVersionStateSchema,
  enabled: Schema.Boolean,
  place: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SKILL_PLACE.builtin), invocable: Schema.Boolean }),
    Schema.Struct({
      kind: Schema.Literal(SKILL_PLACE.local),
      origin: Schema.Literals(["arden", "shared"] as const),
      path: Schema.String
    })
  ])
})

export const SkillListResponseSchema: Schema.Codec<SkillListResponse> = Schema.Struct({
  skills: Schema.Array(SkillSchema)
}).check(
  Schema.makeFilter((response) => {
    const names = new Set(response.skills.map((skill) => skill.name))
    return names.size === response.skills.length
      ? undefined
      : { path: ["skills"], issue: "contains duplicate skill names" }
  })
)

export const MarketplaceSkillSchema = Schema.Struct({
  id: MarketplaceSkillIdSchema,
  name: SkillNameSchema,
  author: MarketplaceSkillAuthorSchema,
  source: MarketplaceSkillSourceSchema,
  installs: NonNegativeIntSchema,
  url: SkillMarketplaceUrlSchema,
  installed: Schema.Boolean
}).check(
  Schema.makeFilter((skill) => {
    if (skill.id !== `${skill.source}/${skill.name}`) {
      return { path: ["id"], issue: "must match source and name" }
    }
    if (skill.author !== skill.source.slice(0, skill.source.indexOf("/"))) {
      return { path: ["author"], issue: "must match the source owner" }
    }
    return skill.url === `https://skills.sh/${skill.id}`
      ? undefined
      : { path: ["url"], issue: "must match the marketplace ID" }
  })
)

export const MarketplaceSkillListResponseSchema: Schema.Codec<MarketplaceSkillListResponse> =
  Schema.Struct({
    skills: Schema.Array(MarketplaceSkillSchema)
  }).check(
    Schema.makeFilter((response) => {
      const ids = new Set(response.skills.map((skill) => skill.id))
      return ids.size === response.skills.length
        ? undefined
        : { path: ["skills"], issue: "contains duplicate marketplace IDs" }
    })
  )

export const MarketplaceSkillInstallInputSchema = Schema.Struct({
  id: MarketplaceSkillIdSchema
})

export const SkillInstallReceiptSchema: Schema.Codec<SkillInstallReceipt> = Schema.Struct({
  status: Schema.Literal("installed"),
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  version: SkillVersionStateSchema
})

export const SkillContentSchema: Schema.Codec<SkillContent> = Schema.Struct({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  version: SkillVersionStateSchema,
  content: SkillContentBodySchema
})

export const SkillToggleReceiptSchema: Schema.Codec<SkillToggleReceipt> = Schema.Struct({
  name: SkillNameSchema,
  enabled: Schema.Boolean
})

export const SkillRemoveReceiptSchema: Schema.Codec<SkillRemoveReceipt> = Schema.Struct({
  status: Schema.Literal("removed"),
  name: SkillNameSchema
})

export const SetSkillEnabledInputSchema = Schema.Struct({
  enabled: Schema.Boolean
})

export const encodeSetSkillEnabledRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(SetSkillEnabledInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMarketplaceSkillInstallRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(MarketplaceSkillInstallInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMarketplaceSkillSearchPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(MarketplaceSkillSearchTextSchema)(value, strict).pipe(
    Effect.map((query) => {
      const search = new URLSearchParams({ q: query })
      return `${skillsCollectionPath}/marketplace/search?${search.toString()}`
    })
  )

export const encodeSkillItemPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(SkillNameSchema)(value).pipe(
    Effect.map((name) => `${skillsCollectionPath}/${encodeURIComponent(name)}`)
  )

export const encodeSkillContentPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  encodeSkillItemPathEffect(value).pipe(Effect.map((path) => `${path}/content`))
