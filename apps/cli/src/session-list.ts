import {
  SESSION_LIST_FILTER,
  SESSION_LIST_PAGE,
  type SessionListOptions
} from "@arden-hq/protocol/sessions"

const ACTIVITY = "activity"

export const latestChats = (limit: number): SessionListOptions => ({
  scope: "primary",
  live: false,
  sort: ACTIVITY,
  limit,
  filter: { kind: SESSION_LIST_FILTER.all },
  page: { kind: SESSION_LIST_PAGE.first }
})

export const oneSession = (sessionId: string): SessionListOptions => ({
  scope: "all",
  live: false,
  sort: ACTIVITY,
  limit: 1,
  filter: { kind: SESSION_LIST_FILTER.sessions, session_ids: [sessionId] },
  page: { kind: SESSION_LIST_PAGE.first }
})

export const liveSessions: SessionListOptions = {
  scope: "all",
  live: true,
  sort: ACTIVITY,
  limit: 100,
  filter: { kind: SESSION_LIST_FILTER.all },
  page: { kind: SESSION_LIST_PAGE.first }
}
