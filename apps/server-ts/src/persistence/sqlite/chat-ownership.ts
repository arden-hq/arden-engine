import { Effect } from "effect"
import { Statement, type SqlClient } from "effect/unstable/sql"
import { activeRunStatusList } from "./status-sets.js"
import { delegatedLinkSql, sessionAncestors, sessionDescendants } from "./tree-walk.js"

export const userChatSql = (alias?: string): Statement.Fragment => {
  const prefix = alias === undefined ? "" : `${alias}.`
  return Statement.fragment([
    Statement.literal(`${prefix}session_type = 'chat' AND ${prefix}origin_automation_id IS NULL`)
  ])
}

type ChatScope =
  | { readonly kind: "space"; readonly spaceId: string }
  | { readonly kind: "chats"; readonly sessionIds: ReadonlyArray<string> }
  | { readonly kind: "within"; readonly sessionId: string }

const rootChats = (sql: SqlClient.SqlClient, scope: ChatScope) => {
  switch (scope.kind) {
    case "space":
      return sql`space_id = ${scope.spaceId}`
    case "chats":
      return sql`session_id IN ${sql.in(scope.sessionIds)}`
    case "within":
      return sql`session_id IN (SELECT session_id FROM up)`
  }
}

const ownedSessions = (sql: SqlClient.SqlClient, scope: ChatScope) => sql`
    ${
      scope.kind === "within"
        ? sql`${sessionAncestors(sql, {
            name: "up",
            from: sql`SELECT session_id FROM sessions WHERE session_id = ${scope.sessionId}`
          })},`
        : sql``
    }
    ${sessionDescendants(sql, {
      name: "owned_tree",
      from: sql`SELECT session_id FROM sessions
        WHERE ${rootChats(sql, scope)} AND ${userChatSql()} AND archived_at IS NULL`,
      where: delegatedLinkSql(sql),
      root: true
    })},
    owned(chat_session_id, session_id, session_ref) AS (
      SELECT owned_tree.root_session_id, owned_tree.session_id, session.public_ref
      FROM owned_tree JOIN sessions AS session ON session.session_id = owned_tree.session_id
    )`

export const isUserChatSession = Effect.fn("Chat.isUserSession")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql`WITH RECURSIVE ${ownedSessions(sql, { kind: "within", sessionId })}
    SELECT 1 FROM owned WHERE session_id = ${sessionId} LIMIT 1`
  return rows.length > 0
})

export interface ChatSettledState {
  readonly session_id: string
  readonly session_ref: string
  readonly title: string | null
  readonly run_id: string | null
  readonly turn_id: string | null
  readonly status: string | null
  readonly pending: number
  readonly settled: boolean
}

export const readChatSettled = (sql: SqlClient.SqlClient, spaceId: string) =>
  chatSettled(sql, { kind: "space", spaceId })

export const readSessionSettled = (sql: SqlClient.SqlClient, sessionIds: ReadonlyArray<string>) =>
  sessionIds.length === 0 ? Effect.succeed([]) : chatSettled(sql, { kind: "chats", sessionIds })

const chatSettled = Effect.fn("Chat.settled")(function* (
  sql: SqlClient.SqlClient,
  scope: ChatScope
) {
  const rows = yield* sql<Omit<ChatSettledState, "settled"> & { readonly active: number }>`
    WITH RECURSIVE ${ownedSessions(sql, scope)}
    SELECT chat.session_id, chat.public_ref AS session_ref, chat.name AS title,
      latest.run_id, json_extract(latest.metadata_json, '$.turn_id') AS turn_id, latest.status,
      (SELECT COUNT(*) FROM owned JOIN session_queued_messages AS queued
        ON queued.session_id = owned.session_id
        WHERE owned.chat_session_id = chat.session_id) AS pending,
      (SELECT COUNT(*) FROM owned JOIN chat_runs AS run ON run.session_id = owned.session_id
        WHERE owned.chat_session_id = chat.session_id AND run.status IN ${activeRunStatusList}) AS active
    FROM sessions AS chat
    LEFT JOIN chat_runs AS latest ON latest.run_id = (
      SELECT run_id FROM chat_runs WHERE session_id = chat.session_id
      ORDER BY started_at DESC, run_id DESC LIMIT 1)
    WHERE chat.session_id IN (SELECT chat_session_id FROM owned)
    ORDER BY chat.session_id`
  return rows.map(({ active, ...row }) => ({ ...row, settled: active === 0 && row.pending === 0 }))
})

export const settledFingerprint = (chats: ReadonlyArray<ChatSettledState>) =>
  chats.map((chat) => ({
    session_id: chat.session_id,
    run_id: chat.run_id,
    state: chat.settled ? chat.status : "unsettled",
    pending: chat.pending
  }))
