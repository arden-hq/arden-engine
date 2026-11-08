import { decoderFor } from "../common/boundary.js"
import { CliAccessSchema, OperationalEventMessageSchema } from "./schema.js"

export * from "./contracts.js"

/** Plain decoders for the private Electron-to-daemon boundary. The protocol
 * owns the Effect runtime used to build and execute its schemas. */
export const daemonDecoders = {
  operationalEventMessage: decoderFor(OperationalEventMessageSchema, "Invalid operational event"),
  cliAccess: decoderFor(CliAccessSchema, "Invalid Arden CLI access file")
} as const
