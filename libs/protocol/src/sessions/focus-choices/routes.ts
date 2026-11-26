import { Schema } from "effect"
import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"
import type { Effect } from "effect/Effect"

const address = Schema.Struct({
  spaceId: routeSegment(),
  questionId: routeSegment()
})

export const encodeFocusChoiceResolvePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    address,
    value,
    ({ spaceId, questionId }) =>
      `/spaces/${encodeSegment(spaceId)}/focus-choices/${encodeSegment(questionId)}/resolve`
  )

export const encodeFocusChoicePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    address,
    value,
    ({ spaceId, questionId }) =>
      `/spaces/${encodeSegment(spaceId)}/focus-choices/${encodeSegment(questionId)}`
  )
