import { projectedDecoderFor } from "../common/boundary.js"
import { ConfigResponseSchema, toConfigSettings } from "./schema.js"

export type { ConfigSettings } from "./contracts.js"

/** The whole `/config` response. A patch goes through `modelRequests.update`. */
export const configDecoders = {
  settings: projectedDecoderFor(ConfigResponseSchema, toConfigSettings, "Invalid config")
} as const
