import { decoderFor, runBoundary, strict } from "../common/boundary.js"
import type { SkillRecipe, SkillRecipeDraftRequest } from "./contracts.js"
import {
  MarketplaceSkillListResponseSchema,
  SkillContentSchema,
  SkillSchema,
  SkillInstallReceiptSchema,
  SkillListResponseSchema,
  SkillRecipeDraftSchema,
  SkillRemoveReceiptSchema,
  SkillToggleReceiptSchema,
  encodeMarketplaceSkillInstallRequestEffect,
  encodeMarketplaceSkillSearchPathEffect,
  encodeSetSkillEnabledRequestEffect,
  encodeSkillContentPathEffect,
  encodeSkillItemPathEffect,
  encodeSkillRecipeDraftRequestEffect,
  encodeSkillRecipePathEffect,
  encodeSkillRecipeRequestEffect
} from "./schema.js"

export * from "./contracts.js"

/** Plain response decoders for local and marketplace Skills operations. */
export const skillDecoders = {
  list: decoderFor(SkillListResponseSchema, "Invalid skill list", strict),
  skill: decoderFor(SkillSchema, "Invalid skill", strict),
  recipeDraft: decoderFor(SkillRecipeDraftSchema, "Invalid recipe draft", strict),
  marketplace: decoderFor(
    MarketplaceSkillListResponseSchema,
    "Invalid skill marketplace response",
    strict
  ),
  content: decoderFor(SkillContentSchema, "Invalid skill content", strict),
  installed: decoderFor(SkillInstallReceiptSchema, "Invalid skill install response", strict),
  toggled: decoderFor(SkillToggleReceiptSchema, "Invalid skill toggle response", strict),
  removed: decoderFor(SkillRemoveReceiptSchema, "Invalid skill removal response", strict)
} as const

/** Semantic inputs become strict reusable JSON request bodies. */
export const skillRequests = {
  recipe(recipe: SkillRecipe): string {
    return runBoundary(encodeSkillRecipeRequestEffect(recipe), "Invalid recipe request", "encode")
  },
  recipeDraft(request: SkillRecipeDraftRequest): string {
    return runBoundary(
      encodeSkillRecipeDraftRequestEffect(request),
      "Invalid recipe draft request",
      "encode"
    )
  },
  installMarketplace(id: string): string {
    return runBoundary(
      encodeMarketplaceSkillInstallRequestEffect({ id }),
      "Invalid marketplace skill install request",
      "encode"
    )
  },
  setEnabled(enabled: boolean): string {
    return runBoundary(
      encodeSetSkillEnabledRequestEffect({ enabled }),
      "Invalid skill toggle request",
      "encode"
    )
  }
} as const

/** Validated paths for the local and marketplace Skills HTTP surface. */
export const skillRoutes = {
  collection: "/skills",
  marketplacePopular: "/skills/marketplace/popular",
  marketplaceSearch(query: string): string {
    return runBoundary(
      encodeMarketplaceSkillSearchPathEffect(query),
      "Invalid skill marketplace search",
      "encode"
    )
  },
  marketplaceInstall: "/skills/marketplace/install",
  recipes: "/skills/recipes",
  recipeDraft: "/skills/recipes/draft",
  recipe(name: string): string {
    return runBoundary(encodeSkillRecipePathEffect(name), "Invalid recipe route", "encode")
  },
  item(name: string): string {
    return runBoundary(encodeSkillItemPathEffect(name), "Invalid skill route", "encode")
  },
  content(name: string): string {
    return runBoundary(encodeSkillContentPathEffect(name), "Invalid skill-content route", "encode")
  }
} as const

/** Shared spelling and boundaries for composer tokens and server-side skill preparation. */
export const skillMentions = (
  text: string
): ReadonlyArray<{
  readonly name: string
  readonly start: number
  readonly end: number
}> =>
  Array.from(text.matchAll(/(?:^|(?<=\s))\/([a-z][a-z0-9-]{0,47})(?![\w/-])/g)).flatMap((match) =>
    match[1] === undefined
      ? []
      : [{ name: match[1], start: match.index, end: match.index + match[0].length }]
  )
