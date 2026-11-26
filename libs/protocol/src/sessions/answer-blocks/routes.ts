import { Schema } from "effect"
import { NonNegativeIntSchema } from "../../common/schema.js"
import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"
import type { Effect } from "effect/Effect"

const statesPath = (sessionId: string): string =>
  `/sessions/${encodeSegment(sessionId)}/answer-blocks`

export const encodeAnswerBlockStatesPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => encodeRouteEffect(routeSegment(), value, statesPath)

const blockAddress = Schema.Struct({
  sessionId: routeSegment(),
  messageId: routeSegment(),
  blockIndex: NonNegativeIntSchema
})

export const encodeAnswerBlockPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    blockAddress,
    value,
    ({ sessionId, messageId, blockIndex }) =>
      `${statesPath(sessionId)}/${encodeSegment(messageId)}/${blockIndex}`
  )
