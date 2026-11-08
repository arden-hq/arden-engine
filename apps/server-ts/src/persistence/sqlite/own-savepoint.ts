import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { rememberTold, type Told, UnitOfWork } from "../unit-of-work.js"

export const inOwnSavepoint = Effect.fn("Sqlite.inOwnSavepoint")(function* <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R | UnitOfWork>
) {
  const unit = yield* UnitOfWork
  const woken: Array<Effect.Effect<void>> = []
  const told: Told = new Map()
  const own = UnitOfWork.of({
    afterCommit: (notify) => Effect.sync(() => void woken.push(notify)),
    markTold: (key, through) => Effect.sync(() => rememberTold(told, key, through)),
    toldThrough: (key) =>
      Effect.map(unit.toldThrough(key), (outer) => {
        const inner = told.get(key)
        return inner === undefined || (outer !== undefined && outer > inner) ? outer : inner
      })
  })
  const exit = yield* Effect.exit(
    sql.withTransaction(effect).pipe(Effect.provideService(UnitOfWork, own))
  )
  if (exit._tag === "Failure") return exit
  yield* Effect.forEach(told, ([key, through]) => unit.markTold(key, through), { discard: true })
  yield* Effect.forEach(woken, unit.afterCommit, { discard: true })
  return exit
})
