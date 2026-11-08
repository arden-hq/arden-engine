import { Effect } from "effect"

import {
  ManagedFileRepository,
  type ManagedFileRepositoryShape
} from "../src/repository/service.js"
import { managedFileRepositoryNodeLayer } from "../src/storage/node.js"

export const useRepository = <A, E>(
  root: string,
  use: (repository: ManagedFileRepositoryShape) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    ManagedFileRepository.pipe(
      Effect.flatMap(use),
      Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
    )
  )

export const requireVersion = Effect.fn("requireVersion")(function* (
  repository: ManagedFileRepositoryShape,
  resourceId: string
) {
  const version = yield* repository.get(resourceId)
  if (version === null)
    return yield* Effect.die(new Error(`expected resource ${resourceId} to exist`))
  return version
})

export const present = <A>(value: A | null | undefined, what: string): A => {
  if (value === null || value === undefined) throw new Error(`expected ${what}`)
  return value
}

export const firstOf = <A>(items: ReadonlyArray<A>, what: string): A =>
  present(items[0], `a ${what}`)
