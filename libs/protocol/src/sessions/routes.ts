import { Schema } from "effect"
import { FindQueryTextSchema, SessionExportFormatSchema } from "./schema.js"

import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"
import {
  SESSION_LIST_FILTER,
  SESSION_LIST_PAGE,
  SESSION_LIST_SCOPE,
  type SessionListFilter,
  type SessionListPage
} from "./contracts.js"
import type { Effect } from "effect/Effect"

const SessionIdSchema = routeSegment()
const SessionListOptionsSchema = Schema.Struct({
  scope: Schema.Literals(Object.values(SESSION_LIST_SCOPE)),
  live: Schema.Boolean,
  limit: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(500)),
  sort: Schema.Literals(["activity", "accessed"] as const),
  filter: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SESSION_LIST_FILTER.all) }),
    Schema.Struct({ kind: Schema.Literal(SESSION_LIST_FILTER.space), space_id: routeSegment() }),
    Schema.Struct({
      kind: Schema.Literal(SESSION_LIST_FILTER.children),
      parent_session_ids: Schema.Array(routeSegment()).check(Schema.isMinLength(1))
    }),
    Schema.Struct({
      kind: Schema.Literal(SESSION_LIST_FILTER.sessions),
      session_ids: Schema.Array(routeSegment()).check(Schema.isMinLength(1))
    }),
    Schema.Struct({ kind: Schema.Literal(SESSION_LIST_FILTER.ref), session_ref: routeSegment() })
  ]),
  page: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SESSION_LIST_PAGE.first) }),
    Schema.Struct({ kind: Schema.Literal(SESSION_LIST_PAGE.offset), offset: NonNegativeIntSchema }),
    Schema.Struct({
      kind: Schema.Literal(SESSION_LIST_PAGE.after),
      cursor: Schema.Struct({ at: Schema.String, session_id: routeSegment() })
    })
  ])
})

const filterParams = (filter: SessionListFilter): ReadonlyArray<readonly [string, string]> => {
  switch (filter.kind) {
    case SESSION_LIST_FILTER.all:
      return []
    case SESSION_LIST_FILTER.space:
      return [["space_id", filter.space_id]]
    case SESSION_LIST_FILTER.children:
      return [["parent_session_ids", filter.parent_session_ids.join(",")]]
    case SESSION_LIST_FILTER.sessions:
      return [["session_ids", filter.session_ids.join(",")]]
    case SESSION_LIST_FILTER.ref:
      return [["session_ref", filter.session_ref]]
  }
}

const pageParams = (page: SessionListPage): ReadonlyArray<readonly [string, string | number]> => {
  switch (page.kind) {
    case SESSION_LIST_PAGE.first:
      return []
    case SESSION_LIST_PAGE.offset:
      return [["offset", page.offset]]
    case SESSION_LIST_PAGE.after:
      return [
        ["cursor_at", page.cursor.at],
        ["cursor_id", page.cursor.session_id]
      ]
  }
}

const SessionExportRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  format: SessionExportFormatSchema
})

export const encodeSessionListPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(SessionListOptionsSchema, value, (options) =>
    appendSearch("/sessions", [
      ["scope", options.scope],
      ["live", options.live],
      ["limit", options.limit],
      ["sort", options.sort],
      ["filter", options.filter.kind],
      ...filterParams(options.filter),
      ["page", options.page.kind],
      ...pageParams(options.page)
    ])
  )

const sessionPath = (sessionId: string): string => `/sessions/${encodeSegment(sessionId)}`

const sessionPathEffect = (value: unknown, suffix = "") =>
  encodeRouteEffect(SessionIdSchema, value, (sessionId) => `${sessionPath(sessionId)}${suffix}`)

export const encodeSessionItemPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value)
export const encodeSessionBranchPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value, "/branch")
export const encodeSessionModelPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value, "/model")
export const encodeSessionMoveToSpacePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value, "/space")
export const encodeSessionExportPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(SessionExportRouteSchema, value, ({ sessionId, format }) =>
    appendSearch(`${sessionPath(sessionId)}/export`, [["format", format]])
  )
const ChatFindRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  query: FindQueryTextSchema
})
export const encodeChatFindPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(ChatFindRouteSchema, value, ({ sessionId, query }) =>
    appendSearch(`${sessionPath(sessionId)}/find`, [["q", query]])
  )
export const encodeChatSearchPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(FindQueryTextSchema, value, (query) =>
    appendSearch("/sessions/search", [["q", query]])
  )
export const encodeSessionTriagePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value, "/triage")
export const encodeSessionRestorePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value, "/restore")
export const encodeSessionContinuePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value, "/continue")
export const encodeSessionOnboardingPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionPathEffect(value, "/onboarding")
const SessionEndRouteSchema = Schema.Struct({ sessionId: routeSegment(), stop: Schema.Boolean })
const sessionEndPathEffect = (value: unknown, suffix: string) =>
  encodeRouteEffect(SessionEndRouteSchema, value, ({ sessionId, stop }) =>
    appendSearch(`${sessionPath(sessionId)}${suffix}`, [["stop", stop ? true : undefined]])
  )
export const encodeSessionArchivePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionEndPathEffect(value, "")
export const encodeSessionPermanentDeletePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => sessionEndPathEffect(value, "/permanent")
