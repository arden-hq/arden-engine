import { Schema } from "effect"
import { FindQueryTextSchema, SessionExportFormatSchema } from "./schema.js"

import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"

const SessionIdSchema = routeSegment()
const SessionListCursorSchema = Schema.Struct({
  at: Schema.String,
  session_id: routeSegment()
})
const SessionListOptionsSchema = Schema.Struct({
  spaceId: Schema.optionalKey(routeSegment()),
  inbox: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Literals(["primary", "agent", "all"] as const)),
  live: Schema.optionalKey(Schema.Boolean),
  parentSessionIds: Schema.optionalKey(Schema.Array(routeSegment())),
  limit: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(500))),
  offset: Schema.optionalKey(NonNegativeIntSchema),
  sort: Schema.optionalKey(Schema.Literals(["activity", "accessed"] as const)),
  cursor: Schema.optionalKey(SessionListCursorSchema),
  sessionIds: Schema.optionalKey(Schema.Array(routeSegment())),
  sessionRef: Schema.optionalKey(routeSegment())
})
const SessionExportRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  format: SessionExportFormatSchema
})

export const encodeSessionListPathEffect = (value: unknown) =>
  encodeRouteEffect(SessionListOptionsSchema, value, (options) =>
    appendSearch("/sessions", [
      ["space_id", options.spaceId],
      ["inbox", options.inbox],
      ["scope", options.scope],
      ["live", options.live],
      ["parent_session_ids", options.parentSessionIds?.join(",")],
      ["limit", options.limit],
      ["offset", options.offset],
      ["sort", options.sort],
      ["cursor_at", options.cursor?.at],
      ["cursor_id", options.cursor?.session_id],
      ["session_ids", options.sessionIds?.join(",")],
      ["session_ref", options.sessionRef]
    ])
  )

const sessionPath = (sessionId: string): string => `/sessions/${encodeSegment(sessionId)}`

const sessionPathEffect = (value: unknown, suffix = "") =>
  encodeRouteEffect(SessionIdSchema, value, (sessionId) => `${sessionPath(sessionId)}${suffix}`)

export const encodeSessionItemPathEffect = (value: unknown) => sessionPathEffect(value)
export const encodeSessionBranchPathEffect = (value: unknown) => sessionPathEffect(value, "/branch")
export const encodeSessionModelPathEffect = (value: unknown) => sessionPathEffect(value, "/model")
export const encodeSessionMoveToSpacePathEffect = (value: unknown) =>
  sessionPathEffect(value, "/space")
export const encodeSessionExportPathEffect = (value: unknown) =>
  encodeRouteEffect(SessionExportRouteSchema, value, ({ sessionId, format }) =>
    appendSearch(`${sessionPath(sessionId)}/export`, [["format", format]])
  )
const ChatFindRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  query: FindQueryTextSchema
})
export const encodeChatFindPathEffect = (value: unknown) =>
  encodeRouteEffect(ChatFindRouteSchema, value, ({ sessionId, query }) =>
    appendSearch(`${sessionPath(sessionId)}/find`, [["q", query]])
  )
export const encodeChatSearchPathEffect = (value: unknown) =>
  encodeRouteEffect(FindQueryTextSchema, value, (query) =>
    appendSearch("/sessions/search", [["q", query]])
  )
export const encodeSessionTriagePathEffect = (value: unknown) => sessionPathEffect(value, "/triage")
export const encodeSessionRestorePathEffect = (value: unknown) =>
  sessionPathEffect(value, "/restore")
export const encodeSessionContinuePathEffect = (value: unknown) =>
  sessionPathEffect(value, "/continue")
const SessionEndRouteSchema = Schema.Struct({ sessionId: routeSegment(), stop: Schema.Boolean })
const sessionEndPathEffect = (value: unknown, suffix: string) =>
  encodeRouteEffect(SessionEndRouteSchema, value, ({ sessionId, stop }) =>
    appendSearch(`${sessionPath(sessionId)}${suffix}`, [["stop", stop ? true : undefined]])
  )
export const encodeSessionArchivePathEffect = (value: unknown) => sessionEndPathEffect(value, "")
export const encodeSessionPermanentDeletePathEffect = (value: unknown) =>
  sessionEndPathEffect(value, "/permanent")
