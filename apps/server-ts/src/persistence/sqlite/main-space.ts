import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { SpaceId } from "../space-job-id.js"

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
