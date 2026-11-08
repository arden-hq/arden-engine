import { Deferred, Effect, Fiber } from "effect"
import { expect, it } from "vitest"

import { Commit, ResourceChange, ResourceVersion } from "../src/domain/model.js"
import { makeHistoryQuery } from "../src/repository/history.js"

const commit = (id: string, parent: Commit | null): Commit =>
  new Commit({
    commitId: id.repeat(64),
    parentId: parent?.commitId ?? null,
    treeId: id.repeat(64),
    actor: "owner",
    origin: "chat",
    reason: "save",
    timestamp: "2026-11-03T00:00:00Z",
    changes: [
      new ResourceChange({
        action: parent === null ? "create" : "update",
        before: parent?.changes[0]?.after ?? null,
        after: new ResourceVersion({
          resourceId: "page",
          path: "page.md",
          blobId: id.repeat(64),
          state: "active",
          versionId: id.repeat(64)
        })
      })
    ]
  })

const first = commit("a", null)
const second = commit("b", first)
const third = commit("c", second)
const commits = new Map([first, second, third].map((value) => [value.commitId, value]))
const loadCommit = (id: string) => {
  const value = commits.get(id)
  return value === undefined ? Effect.die("Missing fixture commit") : Effect.succeed(value)
}
const input = (head: string) => ({
  head,
  resourceId: "page",
  loadCommit,
  validHash: (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
  requireReachable: () => Effect.void,
  validateCommitTransition: () => Effect.void
})

it("cancelled preparation cannot hide earlier provenance from the next query", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const history = makeHistoryQuery()
        const halfway = yield* Deferred.make<void>()
        const blocked = yield* Deferred.make<void>()
        const pending = yield* Effect.forkChild(
          history.prepare({
            head: third.commitId,
            loadCommit: (id) =>
              id === second.commitId
                ? Deferred.succeed(halfway, undefined).pipe(
                    Effect.andThen(Deferred.await(blocked)),
                    Effect.andThen(loadCommit(id))
                  )
                : loadCommit(id)
          })
        )
        yield* Deferred.await(halfway)
        yield* Fiber.interrupt(pending)
        return yield* history.query(input(third.commitId))
      })
    )
  )
  expect(result).toEqual([third, second, first])
})

it("a preparation finishing after a newer query preserves both histories", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const history = makeHistoryQuery()
        const halfway = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const older = yield* Effect.forkChild(
          history.prepare({
            head: second.commitId,
            loadCommit: (id) =>
              id === first.commitId
                ? Deferred.succeed(halfway, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(loadCommit(id))
                  )
                : loadCommit(id)
          })
        )
        yield* Deferred.await(halfway)
        const newer = yield* history.query(input(third.commitId))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(older)
        return [
          newer,
          yield* history.query(input(second.commitId)),
          yield* history.query(input(third.commitId))
        ]
      })
    )
  )
  expect(result).toEqual([
    [third, second, first],
    [second, first],
    [third, second, first]
  ])
})

it("cancelling a shared-head preparation cannot erase a completed reader's provenance", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const history = makeHistoryQuery()
        const halfway = yield* Deferred.make<void>()
        const hold = yield* Deferred.make<void>()
        const pending = yield* Effect.forkChild(
          history.prepare({
            head: third.commitId,
            loadCommit: (id) =>
              id === second.commitId
                ? Deferred.succeed(halfway, undefined).pipe(
                    Effect.andThen(Deferred.await(hold)),
                    Effect.andThen(loadCommit(id))
                  )
                : loadCommit(id)
          })
        )
        yield* Deferred.await(halfway)
        const concurrent = yield* history.query(input(third.commitId))
        yield* Fiber.interrupt(pending)
        return [concurrent, yield* history.query(input(third.commitId))]
      })
    )
  )
  expect(result).toEqual([
    [third, second, first],
    [third, second, first]
  ])
})
