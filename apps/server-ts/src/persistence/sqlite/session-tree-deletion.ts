import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { disposableForkSql } from "../schema/fork-disposition.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { deleteSessionOwnedData } from "./session-deletion.js"
import { sessionActiveWorkSql } from "./work-retention.js"
import { sessionDescendants } from "./tree-walk.js"

export const sessionDeletionTree = (
  sql: SqlClient.SqlClient,
  walk: {
    readonly name: string
    readonly from: Statement.Fragment
    readonly root?: true
  }
) =>
  sessionDescendants(sql, {
    ...walk,
    where: sql`child.session_type = 'agent' OR EXISTS (
        SELECT 1 FROM session_fork_requests AS fork
        WHERE fork.child_session_id = child.session_id
          AND ${sql.literal(disposableForkSql("fork"))})`,
    depth: { max: 64 }
  })

type SessionTreeDeletion =
  | { readonly kind: "missing" }
  | { readonly kind: "active" }
  | { readonly kind: "deleted"; readonly sessions: number }

export const deleteSessionTree = Effect.fn("SqliteSession.deleteTree")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  root: Statement.Fragment
) {
  const rows = yield* sql<{ readonly session_id: string; readonly has_active_work: number }>`
    WITH RECURSIVE ${sessionDeletionTree(sql, {
      name: "owned",
      from: sql`SELECT session_id FROM sessions WHERE ${root}`
    })}
    SELECT s.session_id, ${sessionActiveWorkSql(sql, "s")} AS has_active_work
    FROM sessions AS s
    JOIN (SELECT session_id, MAX(depth) AS depth FROM owned GROUP BY session_id) AS owned
      ON owned.session_id = s.session_id
    ORDER BY owned.depth DESC`
  if (rows.length === 0) return { kind: "missing" } satisfies SessionTreeDeletion
  if (rows.some((row) => row.has_active_work !== 0))
    return { kind: "active" } satisfies SessionTreeDeletion
  for (const row of rows) {
    yield* deleteSessionOwnedData(sql, sessionEvents, row.session_id)
    yield* sql`DELETE FROM sessions WHERE session_id = ${row.session_id}`
  }
  return { kind: "deleted", sessions: rows.length } satisfies SessionTreeDeletion
})
