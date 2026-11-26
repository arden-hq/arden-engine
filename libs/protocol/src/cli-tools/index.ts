import { decoderFor } from "../common/boundary.js"
import { CliToolsReportSchema } from "./schema.js"

export * from "./contracts.js"

export const cliToolDecoders = {
  report: decoderFor(CliToolsReportSchema, "Invalid command-line tools response")
} as const

export const cliToolRoutes = {
  list: "/cli-tools",
  refresh: "/cli-tools/refresh"
}
