import {
  RelayPairDecisionSchema,
  RelayPairOfferSchema,
  RelaySettingsPatchSchema,
  RelayStatusSchema
} from "@arden-hq/protocol/effect/relay"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreInvalid } from "../errors.js"

const failures = [
  StoreInvalid,
  HttpApiError.NotFoundNoContent,
  HttpApiError.ServiceUnavailableNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const

export class RelayApi extends HttpApiGroup.make("relay", { topLevel: true }).add(
  HttpApiEndpoint.get("status", "/relay", {
    success: RelayStatusSchema,
    error: [StoreInvalid, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("pair", "/relay/pair", {
    success: RelayPairOfferSchema,
    error: failures
  }),
  HttpApiEndpoint.post("decide", "/relay/pair/decision", {
    payload: RelayPairDecisionSchema,
    success: RelayStatusSchema,
    error: failures
  }),
  HttpApiEndpoint.delete("remove", "/relay/devices/:dev", {
    params: { dev: Schema.NonEmptyString },
    success: RelayStatusSchema,
    error: failures
  }),
  HttpApiEndpoint.patch("settings", "/relay/settings", {
    payload: RelaySettingsPatchSchema,
    success: RelayStatusSchema,
    error: [StoreInvalid, HttpApiError.InternalServerErrorNoContent]
  })
) {}
