import { encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import type { Effect } from "effect/Effect"
import type { SchemaError } from "effect/SchemaError"

const SpaceIdSchema = routeSegment()

const spacePath = (spaceId: string): string => `/spaces/${encodeSegment(spaceId)}`

const spacePathEffect = (value: unknown, suffix = "") =>
  encodeRouteEffect(SpaceIdSchema, value, (spaceId) => `${spacePath(spaceId)}${suffix}`)

export const encodeSpaceItemPathEffect = (value: unknown): Effect<string, SchemaError, never> =>
  spacePathEffect(value)
export const encodeSpacePagePathEffect = (value: unknown): Effect<string, SchemaError, never> =>
  spacePathEffect(value, "/page")
export const encodeSpaceRestorePathEffect = (value: unknown): Effect<string, SchemaError, never> =>
  spacePathEffect(value, "/restore")
export const encodeSpaceInstructionsPathEffect = (
  value: unknown
): Effect<string, SchemaError, never> => spacePathEffect(value, "/instructions/generate")

export const encodeSpaceConversationPathEffect = (
  value: unknown
): Effect<string, SchemaError, never> => spacePathEffect(value, "/conversation")
