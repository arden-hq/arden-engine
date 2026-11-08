import { encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"

const SpaceIdSchema = routeSegment()

const spacePath = (spaceId: string): string => `/spaces/${encodeSegment(spaceId)}`

const spacePathEffect = (value: unknown, suffix = "") =>
  encodeRouteEffect(SpaceIdSchema, value, (spaceId) => `${spacePath(spaceId)}${suffix}`)

export const encodeSpaceItemPathEffect = (value: unknown) => spacePathEffect(value)
export const encodeSpacePagePathEffect = (value: unknown) => spacePathEffect(value, "/page")
export const encodeSpaceRestorePathEffect = (value: unknown) => spacePathEffect(value, "/restore")
export const encodeSpaceInstructionsPathEffect = (value: unknown) =>
  spacePathEffect(value, "/instructions/generate")

export const encodeSpaceConversationPathEffect = (value: unknown) =>
  spacePathEffect(value, "/conversation")
