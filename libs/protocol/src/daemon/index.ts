import { decoderFor } from "../common/boundary.js"
import {
  CliAccessSchema,
  ConfiguredServerReadySchema,
  OperationalEventMessageSchema
} from "./schema.js"

export * from "./contracts.js"
export * from "./command-line-routes.js"

/** Plain decoders for the private Electron-to-daemon boundary. The protocol
 * owns the Effect runtime used to build and execute its schemas. */
export const daemonDecoders = {
  operationalEventMessage: decoderFor(OperationalEventMessageSchema, "Invalid operational event"),
  cliAccess: decoderFor(CliAccessSchema, "Invalid Arden CLI access file"),
  configuredServerReady: decoderFor(
    ConfiguredServerReadySchema,
    "Invalid configured server ready line"
  )
} as const
