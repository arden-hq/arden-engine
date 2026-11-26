import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { SpaceId } from "../space-job-id.js"
import { activeRunStatusList } from "./status-sets.js"
import { sessionDescendants } from "./tree-walk.js"
import type { Row } from "effect/unstable/sql/SqlConnection"
import type { SqlError } from "effect/unstable/sql/SqlError"

export const mainSpaceId = Effect.fn("MainSpace.id")(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{ readonly space_id: string }>`
    SELECT space_id FROM spaces WHERE kind = 'main'`
  const row = rows[0]
  if (row === undefined) return yield* Effect.die(new Error("The Main Space is missing"))
  return SpaceId.make(row.space_id)
})

export const ownerChatSpace = Effect.fn("MainSpace.ownerChatSpace")(function* (
  sql: SqlClient.SqlClient,
  spaceId: string | null
) {
  return spaceId === null ? yield* mainSpaceId(sql) : SpaceId.make(spaceId)
})

export const mainSpaceIdSql = (sql: SqlClient.SqlClient): Statement.Fragment =>
  sql`(SELECT main.space_id FROM spaces AS main WHERE main.kind = 'main')`

const subtree = (sql: SqlClient.SqlClient, rootId: string) =>
  sessionDescendants(sql, {
    name: "subtree",
    from: sql`SELECT session_id FROM sessions WHERE session_id = ${rootId}`
  })

export const subtreeWorking = (
  sql: SqlClient.SqlClient,
  rootId: string
): Effect.Effect<boolean, SqlError, never> =>
  sql<{ readonly working: number }>`WITH RECURSIVE ${subtree(sql, rootId)}
    SELECT EXISTS (SELECT 1 FROM chat_runs AS run
      WHERE run.session_id IN (SELECT session_id FROM subtree)
        AND run.status IN ${activeRunStatusList}) AS working`.pipe(
    Effect.map((rows) => rows[0]?.working === 1)
  )

export const descendantsFollowRoot = (
  sql: SqlClient.SqlClient,
  rootId: string
): Statement.Statement<Row> => sql`
  WITH RECURSIVE ${subtree(sql, rootId)}
  UPDATE sessions
  SET space_id = (SELECT root.space_id FROM sessions AS root WHERE root.session_id = ${rootId})
  WHERE space_id IS NULL AND session_id IN (SELECT session_id FROM subtree)`
