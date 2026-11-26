import { decoderFor, runBoundary, strict } from "../common/boundary.js"
import {
  MarketplaceSkillListResponseSchema,
  SkillContentSchema,
  SkillSchema,
  SkillInstallReceiptSchema,
  SkillListResponseSchema,
  SkillRemoveReceiptSchema,
  SkillToggleReceiptSchema,
  encodeMarketplaceSkillInstallRequestEffect,
  encodeMarketplaceSkillSearchPathEffect,
  encodeSetSkillEnabledRequestEffect,
  encodeSkillContentPathEffect,
  encodeSkillItemPathEffect,
  SKILL_NAME_PATTERN
} from "./schema.js"

export * from "./contracts.js"

export const skillDecoders = {
  list: decoderFor(SkillListResponseSchema, "Invalid skill list", strict),
  skill: decoderFor(SkillSchema, "Invalid skill", strict),
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

export const skillRequests = {
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
  item(name: string): string {
    return runBoundary(encodeSkillItemPathEffect(name), "Invalid skill route", "encode")
  },
  content(name: string): string {
    return runBoundary(encodeSkillContentPathEffect(name), "Invalid skill-content route", "encode")
  }
} as const

const SKILL_MENTION = new RegExp(`(?:^|(?<=\\s))/(${SKILL_NAME_PATTERN})(?![\\w/-])`, "g")

export const skillMentions = (
  text: string
): ReadonlyArray<{
  readonly name: string
  readonly start: number
  readonly end: number
}> =>
  Array.from(text.matchAll(SKILL_MENTION)).flatMap((match) =>
    match[1] === undefined
      ? []
      : [{ name: match[1], start: match.index, end: match.index + match[0].length }]
  )
