import {
  MarketplaceSkillInstallInputSchema,
  MarketplaceSkillListResponseSchema,
  MarketplaceSkillSearchQuerySchema,
  SetSkillEnabledInputSchema,
  SkillContentSchema,
  SkillInstallReceiptSchema,
  SkillListResponseSchema,
  SkillNameSchema,
  SkillRemoveReceiptSchema,
  SkillToggleReceiptSchema
} from "@arden-hq/protocol/effect/skills"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

import { StoreInvalid } from "../errors.js"

const skillErrors = [
  HttpApiError.NotFoundNoContent,
  StoreInvalid,
  HttpApiError.ServiceUnavailableNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const

export class SkillsApi extends HttpApiGroup.make("skills", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/skills", {
    success: SkillListResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("marketplacePopular", "/skills/marketplace/popular", {
    success: MarketplaceSkillListResponseSchema,
    error: skillErrors
  }),
  HttpApiEndpoint.get("marketplaceSearch", "/skills/marketplace/search", {
    query: MarketplaceSkillSearchQuerySchema,
    success: MarketplaceSkillListResponseSchema,
    error: skillErrors
  }),
  HttpApiEndpoint.post("installMarketplace", "/skills/marketplace/install", {
    payload: MarketplaceSkillInstallInputSchema,
    success: SkillInstallReceiptSchema,
    error: skillErrors
  }),
  HttpApiEndpoint.get("content", "/skills/:name/content", {
    params: { name: SkillNameSchema },
    success: SkillContentSchema,
    error: skillErrors
  }),
  HttpApiEndpoint.patch("setEnabled", "/skills/:name", {
    params: { name: SkillNameSchema },
    payload: SetSkillEnabledInputSchema,
    success: SkillToggleReceiptSchema,
    error: skillErrors
  }),
  HttpApiEndpoint.delete("remove", "/skills/:name", {
    params: { name: SkillNameSchema },
    success: SkillRemoveReceiptSchema,
    error: skillErrors
  })
) {}
