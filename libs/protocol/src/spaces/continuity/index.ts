import { decoderFor, makeEncoder, runBoundary } from "../../common/boundary.js"
import type { AcknowledgeSpaceContinuityRequest } from "./contracts.js"
import {
  SpaceContinuitySeenStateSchema,
  SpaceContinuityStateResponseSchema,
  encodeAcknowledgeSpaceContinuityRequestEffect
} from "./schema.js"
import {
  encodeSpaceContinuityAcknowledgePathEffect,
  encodeSpaceContinuityStatePathEffect
} from "./routes.js"

export * from "./contracts.js"

export const spaceContinuityDecoders = {
  seen: decoderFor(SpaceContinuitySeenStateSchema, "Invalid Space continuity seen state"),
  state: decoderFor(SpaceContinuityStateResponseSchema, "Invalid Space continuity state")
} as const

export const spaceContinuityRequests = {
  acknowledge: makeEncoder<AcknowledgeSpaceContinuityRequest>(
    encodeAcknowledgeSpaceContinuityRequestEffect,
    "Invalid Space continuity acknowledgement"
  )
} as const

const route = (program: ReturnType<typeof encodeSpaceContinuityStatePathEffect>): string =>
  runBoundary(program, "Invalid Space continuity route", "encode")

export const spaceContinuityRoutes = {
  state(spaceId: string): string {
    return route(encodeSpaceContinuityStatePathEffect(spaceId))
  },
  acknowledge(spaceId: string): string {
    return route(encodeSpaceContinuityAcknowledgePathEffect(spaceId))
  }
} as const
