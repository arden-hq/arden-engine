import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Context, Effect, Exit, Layer, Scope } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { encodeUtf8 } from "../src/domain/format.js"
import { ChangeSet, Create, Update } from "../src/domain/model.js"
import { ManagedFileRepository } from "../src/repository/service.js"
import { managedFileRepositoryNodeLayer } from "../src/storage/node.js"
import { requireVersion } from "./kit.js"

const roots: string[] = []
const scopes: Scope.Closeable[] = []

afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void)))
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type RepositoryOptions = Omit<Parameters<typeof managedFileRepositoryNodeLayer>[0], "workingRoot">

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "arden-revisions-parity-"))
  roots.push(root)
  return root
}

const openRepository = async (
  root: string,
  options: RepositoryOptions = {}
): Promise<ManagedFileRepository["Service"]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      scopes.push(scope)
      const context = yield* Layer.buildWithScope(
        managedFileRepositoryNodeLayer({ workingRoot: root, ...options }),
        scope
      )
      return Context.get(context, ManagedFileRepository)
    })
  )

const changeSet = (
  operations: ConstructorParameters<typeof ChangeSet>[0]["operations"],
  idempotencyKey: string,
  expectedHead: string | null = null,
  enforceExpectedHead = false
): ChangeSet =>
  new ChangeSet({
    operations,
    actor: "tester",
    origin: "parity-test",
    reason: "exercise revision contract",
    idempotencyKey,
    expectedHead,
    enforceExpectedHead
  })

const content = (value: string): Uint8Array => encodeUtf8(value)

describe("durable repository parity", () => {
  it("replays exact idempotent requests and rejects conflicting reuse", async () => {
    const root = await makeRoot()
    const repository = await openRepository(root)
    const request = changeSet(
      [new Create({ resourceId: "note", path: "note.md", content: content("one") })],
      "retry"
    )
    const first = await Effect.runPromise(repository.commit(request))
    const replay = await Effect.runPromise(repository.commit(request))
    expect(replay.replayed).toBe(true)
    expect(replay.commit.commitId).toBe(first.commit.commitId)
    expect((await Effect.runPromise(repository.history())).length).toBe(1)

    const conflict = await Effect.runPromise(
      Effect.exit(
        repository.commit(
          changeSet(
            [new Create({ resourceId: "note", path: "note.md", content: content("different") })],
            "retry"
          )
        )
      )
    )
    expect(Exit.isFailure(conflict)).toBe(true)
  })

  it("allows only one stale-version contender to publish", async () => {
    const root = await makeRoot()
    const repository = await openRepository(root)
    await Effect.runPromise(
      repository.commit(
        changeSet(
          [new Create({ resourceId: "note", path: "note.md", content: content("zero") })],
          "seed"
        )
      )
    )
    const expectedVersion = (await Effect.runPromise(requireVersion(repository, "note"))).versionId
    const outcomes = await Promise.allSettled(
      [1, 2].map((index) =>
        Effect.runPromise(
          repository.commit(
            changeSet(
              [
                new Update({
                  resourceId: "note",
                  expectedVersion,
                  content: content(`winner-${index}`)
                })
              ],
              `contender-${index}`
            )
          )
        )
      )
    )

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1)
    const current = await Effect.runPromise(requireVersion(repository, "note"))
    expect(
      new TextDecoder().decode(await Effect.runPromise(repository.readVersion(current)))
    ).toMatch(/^winner-[12]$/)
  })
})
