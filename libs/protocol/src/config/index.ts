import { projectedDecoderFor } from "../common/boundary.js"
import { ConfigResponseSchema, toConfigSettings } from "./schema.js"

export type { ConfigSettings } from "./contracts.js"

export const configDecoders = {
  settings: projectedDecoderFor(ConfigResponseSchema, toConfigSettings, "Invalid config")
} as const
