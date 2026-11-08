import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"

const SpaceIdSchema = routeSegment()

export const encodeSpaceContinuityStatePathEffect = (value: unknown) =>
  encodeRouteEffect(
    SpaceIdSchema,
    value,
    (spaceId) => `/spaces/${encodeSegment(spaceId)}/continuity/state`
  )

export const encodeSpaceContinuityAcknowledgePathEffect = (value: unknown) =>
  encodeRouteEffect(
    SpaceIdSchema,
    value,
    (spaceId) => `/spaces/${encodeSegment(spaceId)}/continuity/acknowledge`
  )
