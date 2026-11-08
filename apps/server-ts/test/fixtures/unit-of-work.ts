import { Effect } from "effect"
import { makeUnitOfWork, UnitOfWork } from "../../src/persistence/unit-of-work.js"

export const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(
    effect,
    UnitOfWork,
    makeUnitOfWork(() => Effect.void)
  )
