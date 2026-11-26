import {
  SESSION_LIST_FILTER,
  SESSION_LIST_PAGE,
  SESSION_TARGET,
  type SessionTarget
} from "@arden-hq/protocol/sessions"
import type { SessionListQuerySchema } from "@arden-hq/protocol/effect/sessions"
import type { SessionListQuery } from "../../persistence/sessions/store.js"

const QUERY_BOOLEAN = { true: "true" } as const

export const targetSessionId = (target: SessionTarget): string | undefined =>
  target.kind === SESSION_TARGET.session ? target.session_id : undefined

const idList = (ids: string): ReadonlyArray<string> => ids.split(",").filter((id) => id.length > 0)

const listFilter = (query: typeof SessionListQuerySchema.Type): SessionListQuery => {
  switch (query.filter) {
    case SESSION_LIST_FILTER.all:
      return {}
    case SESSION_LIST_FILTER.space:
      return { spaceId: query.space_id }
    case SESSION_LIST_FILTER.children:
      return { parentSessionIds: idList(query.parent_session_ids) }
    case SESSION_LIST_FILTER.sessions:
      return { sessionIds: idList(query.session_ids) }
    case SESSION_LIST_FILTER.ref:
      return { sessionRef: query.session_ref }
  }
}

const listPage = (query: typeof SessionListQuerySchema.Type): SessionListQuery => {
  switch (query.page) {
    case SESSION_LIST_PAGE.first:
      return {}
    case SESSION_LIST_PAGE.offset:
      return { offset: query.offset }
    case SESSION_LIST_PAGE.after:
      return { cursor: { at: query.cursor_at, sessionId: query.cursor_id } }
  }
}

export const listOptions = (query: typeof SessionListQuerySchema.Type): SessionListQuery => ({
  ...listFilter(query),
  ...listPage(query),
  scope: query.scope,
  live: query.live === true || query.live === QUERY_BOOLEAN.true,
  limit: query.limit,
  sort: query.sort
})
