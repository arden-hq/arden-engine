import { Schema } from "effect"
import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"

const scope = Schema.Union([
  Schema.Struct({ place: Schema.Literal("space"), spaceId: routeSegment() }),
  Schema.Struct({ place: Schema.Literal("chat"), sessionId: routeSegment() }),
  Schema.Struct({ place: Schema.Literal("home") })
])

export const encodeTaskProposalListPathEffect = (value: unknown) =>
  encodeRouteEffect(scope, value, (decoded) =>
    appendSearch("/proposals", [
      ["place", decoded.place],
      ["space_id", decoded.place === "space" ? decoded.spaceId : undefined],
      ["session_id", decoded.place === "chat" ? decoded.sessionId : undefined]
    ])
  )

export const encodeTaskProposalResolvePathEffect = (value: unknown) =>
  encodeRouteEffect(
    routeSegment(),
    value,
    (proposalId) => `/proposals/${encodeSegment(proposalId)}/resolve`
  )

export const encodeTaskProposalRecheckPathEffect = (value: unknown) =>
  encodeRouteEffect(
    routeSegment(),
    value,
    (proposalId) => `/proposals/${encodeSegment(proposalId)}/recheck`
  )
