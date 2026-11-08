import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill, BackfillContext } from "./backfills/backfill.js"
import { SessionLifecycleEvents } from "../sessions/events.js"
import { inOwnSavepoint } from "./own-savepoint.js"
import { deleteSessionTree } from "./session-tree-deletion.js"

const TREES_PER_CHUNK = 20

const orphanAgent = `session_type = 'agent' AND NOT EXISTS (
  SELECT 1 FROM sessions AS parent WHERE parent.session_id = sessions.parent_session_id)`

export const orphanAgentSessionsBackfill: Backfill<unknown, BackfillContext> = {
  name: "orphan_agent_sessions",
  chunk: Effect.fn("OrphanAgentSessions.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const sessionEvents = yield* SessionLifecycleEvents
    const orphans = yield* sql<{ readonly session_id: string }>`SELECT session_id FROM sessions
      WHERE session_id > ${cursor ?? ""} AND ${sql.literal(orphanAgent)}
      ORDER BY session_id LIMIT ${Math.min(limit, TREES_PER_CHUNK)}`
    let converted = 0
    for (const orphan of orphans) {
      const deleted = yield* inOwnSavepoint(
        sql,
        deleteSessionTree(
          sql,
          sessionEvents,
          sql`session_id = ${orphan.session_id} AND ${sql.literal(orphanAgent)}`
        )
      )
      if (deleted._tag === "Failure")
        yield* Effect.logWarning("Could not delete an orphaned agent", {
          sessionId: orphan.session_id,
          cause: deleted.cause
        })
      else if (deleted.value.kind === "deleted") converted += deleted.value.sessions
    }
    return { converted, next: orphans.at(-1)?.session_id }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM sessions
      WHERE ${sql.literal(orphanAgent)}`
    return rows[0]?.count ?? 0
  })
}
