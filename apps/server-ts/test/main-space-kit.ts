import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { SpaceStore } from "../src/persistence/spaces/store.js"

export const AT = "2026-11-20T00:00:00.000Z"

export const mainSpace = Effect.gen(function* () {
  const spaces = yield* SpaceStore
  const listed = yield* spaces.list()
  const main = listed.find((space) => space.kind === "main")
  if (main === undefined) return yield* Effect.die("no Main Space")
  return main
})
export const spaceOf = (
  sessionId: string
): Effect.Effect<string | null | undefined, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly space_id: string | null }>`
      SELECT space_id FROM sessions WHERE session_id = ${sessionId}`
    return rows[0]?.space_id
  })
