import { Schema } from "effect"
import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import type { Effect } from "effect/Effect"
import { TASK_PROPOSAL_PLACEMENT } from "./contracts.js"

const scope = Schema.Union([
  Schema.Struct({ place: Schema.Literal(TASK_PROPOSAL_PLACEMENT.space), spaceId: routeSegment() }),
  Schema.Struct({ place: Schema.Literal(TASK_PROPOSAL_PLACEMENT.chat), sessionId: routeSegment() })
])

export const encodeTaskProposalListPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(scope, value, (decoded) =>
    appendSearch("/proposals", [
      ["place", decoded.place],
      ["space_id", decoded.place === TASK_PROPOSAL_PLACEMENT.space ? decoded.spaceId : undefined],
      ["session_id", decoded.place === TASK_PROPOSAL_PLACEMENT.chat ? decoded.sessionId : undefined]
    ])
  )

export const encodeTaskProposalResolvePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    routeSegment(),
    value,
    (proposalId) => `/proposals/${encodeSegment(proposalId)}/resolve`
  )

export const encodeTaskProposalRecheckPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    routeSegment(),
    value,
    (proposalId) => `/proposals/${encodeSegment(proposalId)}/recheck`
  )
