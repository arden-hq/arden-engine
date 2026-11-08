import { Effect, Schema } from "effect"
import type {
  MarketplaceSkillListResponse,
  Skill,
  SkillContent,
  SkillInstallReceipt,
  SkillListResponse,
  SkillRecipeDraft,
  SkillRecipeDraftRequest,
  SkillRemoveReceipt,
  SkillToggleReceipt
} from "./contracts.js"
import { NonNegativeIntSchema } from "../common/schema.js"

const strict = { onExcessProperty: "error" } as const
const skillsCollectionPath = "/skills"

export const SkillNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/))

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
    const separator = value.lastIndexOf("/")
    if (separator <= 0) return "must contain a source and skill name"
    const source = value.slice(0, separator)
    const name = value.slice(separator + 1)
    return isMarketplaceSkillSource(source) && isSkillName(name)
      ? undefined
      : "must be a GitHub owner/repository/skill ID"
  })
)

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

export const SkillRecipeTitleSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.makeFilter((value) => (value === value.trim() ? undefined : "must be trimmed"))
)

export const SkillRecipeSpaceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128)
)

export const SkillRecipeSchema = Schema.Struct({
  title: SkillRecipeTitleSchema,
  prompt: SkillContentBodySchema.check(Schema.isMinLength(1)),
  space_id: Schema.NullOr(SkillRecipeSpaceIdSchema)
})

export const SkillRecipeDraftRequestSchema: Schema.Codec<SkillRecipeDraftRequest> = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))
})

export const SkillRecipeDraftSchema: Schema.Codec<SkillRecipeDraft> = Schema.Struct({
  title: SkillRecipeTitleSchema,
  prompt: SkillContentBodySchema.check(Schema.isMinLength(1))
})

export const SkillSchema: Schema.Codec<Skill> = Schema.Struct({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  version: Schema.NullOr(SkillVersionSchema),
  enabled: Schema.Boolean,
  builtin: Schema.Boolean,
  invocable: Schema.optionalKey(Schema.Literal(true)),
  origin: Schema.optionalKey(Schema.Literals(["arden", "shared"] as const)),
  path: Schema.optionalKey(Schema.String),
  recipe: Schema.NullOr(SkillRecipeSchema)
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
  version: Schema.NullOr(SkillVersionSchema)
})

export const SkillContentSchema: Schema.Codec<SkillContent> = Schema.Struct({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  version: Schema.NullOr(SkillVersionSchema),
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

export const encodeSetSkillEnabledRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SetSkillEnabledInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeSkillRecipeRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SkillRecipeSchema)(value, strict).pipe(Effect.map(JSON.stringify))

export const encodeSkillRecipeDraftRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SkillRecipeDraftRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMarketplaceSkillInstallRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(MarketplaceSkillInstallInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMarketplaceSkillSearchPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(MarketplaceSkillSearchTextSchema)(value, strict).pipe(
    Effect.map((query) => {
      const search = new URLSearchParams({ q: query })
      return `${skillsCollectionPath}/marketplace/search?${search.toString()}`
    })
  )

export const encodeSkillItemPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SkillNameSchema)(value).pipe(
    Effect.map((name) => `${skillsCollectionPath}/${encodeURIComponent(name)}`)
  )

export const encodeSkillRecipePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SkillNameSchema)(value).pipe(
    Effect.map((name) => `${skillsCollectionPath}/recipes/${encodeURIComponent(name)}`)
  )

export const encodeSkillContentPathEffect = (value: unknown) =>
  encodeSkillItemPathEffect(value).pipe(Effect.map((path) => `${path}/content`))
