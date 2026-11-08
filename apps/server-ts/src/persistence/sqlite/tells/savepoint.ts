import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { UnitOfWork } from "../../unit-of-work.js"
import { inOwnSavepoint } from "../own-savepoint.js"

export const tellInOwnSavepoint = Effect.fn("Tells.inOwnSavepoint")(function* <A, E, R>(
  sql: SqlClient.SqlClient,
  what: Record<string, unknown>,
  effect: Effect.Effect<A, E, R | UnitOfWork>
) {
  const exit = yield* inOwnSavepoint(sql, effect)
  if (exit._tag === "Failure")
    yield* Effect.logWarning("Could not tell a change", { ...what, cause: exit.cause })
})
