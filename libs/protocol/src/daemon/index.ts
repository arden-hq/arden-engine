import { Schema } from "effect"
import { decoderFor } from "../common/boundary.js"
import {
  CliAccessSchema,
  ConfiguredServerReadySchema,
  OperationalEventMessageSchema
} from "./schema.js"

export * from "./contracts.js"
export * from "./command-line-routes.js"

export const daemonDecoders = {
  operationalEventMessage: decoderFor(OperationalEventMessageSchema, "Invalid operational event"),
  cliAccess: decoderFor(CliAccessSchema, "Invalid Arden CLI access file"),
  cliAccessText: decoderFor(
    Schema.fromJsonString(CliAccessSchema),
    "Invalid Arden CLI access file"
  ),
  configuredServerReady: decoderFor(
    ConfiguredServerReadySchema,
    "Invalid configured server ready line"
  ),
  configuredServerReadyText: decoderFor(
    Schema.fromJsonString(ConfiguredServerReadySchema),
    "Invalid configured server ready line"
  )
} as const
