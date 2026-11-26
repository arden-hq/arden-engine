import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"
import type { Effect } from "effect/Effect"
import type { SchemaError } from "effect/SchemaError"

const SessionIdSchema = routeSegment()

const todoPath = (sessionId: string): string => `/sessions/${encodeSegment(sessionId)}/todo`

export const encodeTodoPathEffect = (value: unknown): Effect<string, SchemaError, never> =>
  encodeRouteEffect(SessionIdSchema, value, todoPath)

export const encodeTodoOverridePathEffect = (value: unknown): Effect<string, SchemaError, never> =>
  encodeRouteEffect(SessionIdSchema, value, (sessionId) => `${todoPath(sessionId)}/override`)
