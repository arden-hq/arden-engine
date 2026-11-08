import { Schema } from "effect"
import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"

const address = Schema.Struct({
  spaceId: routeSegment(),
  questionId: routeSegment()
})

export const encodeFocusChoiceResolvePathEffect = (value: unknown) =>
  encodeRouteEffect(
    address,
    value,
    ({ spaceId, questionId }) =>
      `/spaces/${encodeSegment(spaceId)}/focus-choices/${encodeSegment(questionId)}/resolve`
  )

export const encodeFocusChoicePathEffect = (value: unknown) =>
  encodeRouteEffect(
    address,
    value,
    ({ spaceId, questionId }) =>
      `/spaces/${encodeSegment(spaceId)}/focus-choices/${encodeSegment(questionId)}`
  )
