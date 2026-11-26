import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"
import type { Effect } from "effect/Effect"
import type { SchemaError } from "effect/SchemaError"

const SpaceIdSchema = routeSegment()

export const encodeSpaceContinuityStatePathEffect = (
  value: unknown
): Effect<string, SchemaError, never> =>
  encodeRouteEffect(
    SpaceIdSchema,
    value,
    (spaceId) => `/spaces/${encodeSegment(spaceId)}/continuity/state`
  )

export const encodeSpaceContinuityAcknowledgePathEffect = (
  value: unknown
): Effect<string, SchemaError, never> =>
  encodeRouteEffect(
    SpaceIdSchema,
    value,
    (spaceId) => `/spaces/${encodeSegment(spaceId)}/continuity/acknowledge`
  )
