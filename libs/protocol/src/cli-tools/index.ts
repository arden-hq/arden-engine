import { decoderFor } from "../common/boundary.js"
import { CliToolsReportSchema } from "./schema.js"

export * from "./contracts.js"

export const cliToolDecoders = {
  report: decoderFor(CliToolsReportSchema, "Invalid command-line tools response")
} as const

export const cliToolRoutes = {
  /** The last detection; the first read runs one. */
  list: "/cli-tools",
  /** Detects again and answers the new report. */
  refresh: "/cli-tools/refresh"
} as const
