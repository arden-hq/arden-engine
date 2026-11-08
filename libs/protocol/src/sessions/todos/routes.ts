import { encodeRouteEffect, encodeSegment, routeSegment } from "../../common/routes.js"

const SessionIdSchema = routeSegment()

const todoPath = (sessionId: string): string => `/sessions/${encodeSegment(sessionId)}/todo`

export const encodeTodoPathEffect = (value: unknown) =>
  encodeRouteEffect(SessionIdSchema, value, todoPath)

export const encodeTodoOverridePathEffect = (value: unknown) =>
  encodeRouteEffect(SessionIdSchema, value, (sessionId) => `${todoPath(sessionId)}/override`)
