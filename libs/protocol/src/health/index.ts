import { projectedDecoderFor } from "../common/boundary.js"
import { HealthResponseSchema, toHealthStatus } from "./schema.js"

export * from "./contracts.js"

export const healthDecoders = {
  status: projectedDecoderFor(HealthResponseSchema, toHealthStatus, "Invalid health response")
} as const

export const healthRoutes = {
  status: "/health"
} as const
