import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Exit } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { RevisionStorageError } from "../src/domain/errors.js"
import { encodeUtf8 } from "../src/domain/format.js"
import { ChangeSet, Create, Update } from "../src/domain/model.js"
import {
  ManagedFileRepository,
  type ManagedFileRepositoryShape
} from "../src/repository/service.js"
import { managedFileRepositoryNodeLayer } from "../src/storage/node.js"
import { firstOf, requireVersion, useRepository } from "./kit.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const withRepository = async <A, E>(
  use: (repository: ManagedFileRepositoryShape) => Effect.Effect<A, E>
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "arden-revisions-"))
  roots.push(root)
  return useRepository(root, use)
}

const create = (resourceId: string, path: string, text: string) =>
  new Create({ resourceId, path, content: encodeUtf8(text) })

const changeSet = (
  operations: ConstructorParameters<typeof ChangeSet>[0]["operations"],
  idempotencyKey: string
): ChangeSet =>
  new ChangeSet({
    operations,
    actor: "tester",
    origin: "test",
    reason: "exercise revision contract",
    idempotencyKey,
    expectedHead: null,
    enforceExpectedHead: false
  })

describe("durable revisions repository", () => {
  it("initializes with the default history child and commits/reopens content", async () => {
    const root = await mkdtemp(join(tmpdir(), "arden-revisions-"))
    roots.push(root)
    const result = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const first = yield* repository.commit(
          new ChangeSet({
            operations: [
              new Create({
                resourceId: "guide",
                path: "docs/guide.md",
                content: encodeUtf8("one\n")
              })
            ],
            actor: "alice",
            origin: "test",
            reason: "create",
            idempotencyKey: "create-guide",
            expectedHead: null,
            enforceExpectedHead: false
          })
        )
        const version = yield* requireVersion(repository, "guide")
        expect(version?.path).toBe("docs/guide.md")
        expect(new TextDecoder().decode(yield* repository.read("guide"))).toBe("one\n")
        return { commitId: first.commit.commitId, versionId: version?.versionId }
      })
    )
    expect(result.commitId).toHaveLength(64)
    const reopened = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        expect(yield* repository.head).toBe(result.commitId)
        expect((yield* repository.get("guide"))?.versionId).toBe(result.versionId)
        expect(new TextDecoder().decode(yield* repository.read("guide"))).toBe("one\n")
        return true
      })
    )
    expect(reopened).toBe(true)
  })

  it("rejects a stale per-resource version and keeps the current content", async () => {
    await withRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.commit(changeSet([create("note", "note.md", "one")], "cas-1"))
        const stale = (yield* requireVersion(repository, "note")).versionId
        yield* repository.commit(
          changeSet(
            [
              new Update({ resourceId: "note", expectedVersion: stale, content: encodeUtf8("two") })
            ],
            "cas-2"
          )
        )
        const failure = yield* Effect.exit(
          repository.commit(
            changeSet(
              [
                new Update({
                  resourceId: "note",
                  expectedVersion: stale,
                  content: encodeUtf8("three")
                })
              ],
              "cas-3"
            )
          )
        )
        expect(Exit.isFailure(failure)).toBe(true)
        expect(new TextDecoder().decode(yield* repository.read("note"))).toBe("two")
      })
    )
  })

  it("rolls back a transaction interrupted after working-file displacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "arden-revisions-"))
    roots.push(root)
    const first = await useRepository(root, (repository) =>
      repository.commit(
        new ChangeSet({
          operations: [
            new Create({ resourceId: "note", path: "note.md", content: encodeUtf8("one") })
          ],
          actor: "alice",
          origin: "test",
          reason: "create",
          idempotencyKey: "crash-1",
          expectedHead: null,
          enforceExpectedHead: false
        })
      )
    )
    const interrupted = Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const version = yield* requireVersion(repository, "note")
      expect(version).not.toBeNull()
      const exit = yield* Effect.exit(
        repository.commit(
          new ChangeSet({
            operations: [
              new Update({
                resourceId: "note",
                expectedVersion: version.versionId,
                content: encodeUtf8("two")
              })
            ],
            actor: "alice",
            origin: "test",
            reason: "update",
            idempotencyKey: "crash-2",
            expectedHead: first.commit.commitId,
            enforceExpectedHead: false
          })
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(
      Effect.provide(
        managedFileRepositoryNodeLayer({
          workingRoot: root,
          checkpoint: (stage) =>
            stage === "before_ref"
              ? Effect.fail(new RevisionStorageError({ message: "simulated process stop" }))
              : Effect.void
        })
      )
    )
    await Effect.runPromise(interrupted)

    const recovered = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        expect(yield* repository.head).toBe(first.commit.commitId)
        return new TextDecoder().decode(yield* repository.read("note"))
      })
    )
    expect(recovered).toBe("one")
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("one")
  })

  it("preserves external drift and quarantines an interrupted transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "arden-revisions-"))
    roots.push(root)
    const first = await useRepository(root, (repository) =>
      repository.commit(
        new ChangeSet({
          operations: [
            new Create({ resourceId: "note", path: "note.md", content: encodeUtf8("old") })
          ],
          actor: "alice",
          origin: "test",
          reason: "create",
          idempotencyKey: "quarantine-1",
          expectedHead: null,
          enforceExpectedHead: false
        })
      )
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const version = yield* requireVersion(repository, "note")
        yield* Effect.exit(
          repository.commit(
            new ChangeSet({
              operations: [
                new Update({
                  resourceId: "note",
                  expectedVersion: version.versionId,
                  content: encodeUtf8("candidate")
                })
              ],
              actor: "alice",
              origin: "test",
              reason: "update",
              idempotencyKey: "quarantine-2",
              expectedHead: first.commit.commitId,
              enforceExpectedHead: false
            })
          )
        )
      }).pipe(
        Effect.provide(
          managedFileRepositoryNodeLayer({
            workingRoot: root,
            checkpoint: (stage) =>
              stage === "before_ref"
                ? Effect.fail(new RevisionStorageError({ message: "simulated process stop" }))
                : Effect.void
          })
        )
      )
    )

    const transactions = join(root, ".managed-history", "transactions")
    const transactionId = firstOf(await readdir(transactions), "transaction directory")
    const manifest = JSON.parse(
      await readFile(join(transactions, transactionId, "manifest.jsonl"), "utf8")
    )
    expect(manifest.version).toBe(2)
    await writeFile(join(root, "note.md"), "external")

    const issues = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        expect(yield* repository.head).toBe(first.commit.commitId)
        expect(new TextDecoder().decode(yield* repository.read("note"))).toBe("old")
        return (yield* repository.integrityReport).issues.map((issue) => issue.code)
      })
    )
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("external")
    expect(await readdir(transactions)).toEqual([])
    expect(await readdir(join(root, ".managed-history", "conflicts"))).toEqual([transactionId])
    expect(issues).toContain("managed_file_mismatch")
    expect(issues).toContain("recovery_conflict")
  })

  it("replays exact idempotent requests and rejects conflicting reuse", async () => {
    await withRepository((repository) =>
      Effect.gen(function* () {
        const request = changeSet([create("note", "note.md", "one")], "retry")
        const first = yield* repository.commit(request)
        const replay = yield* repository.commit(request)
        expect(replay.replayed).toBe(true)
        expect(replay.commit.commitId).toBe(first.commit.commitId)
        expect((yield* repository.history()).length).toBe(1)

        const conflict = yield* Effect.exit(
          repository.commit(changeSet([create("note", "note.md", "different")], "retry"))
        )
        expect(Exit.isFailure(conflict)).toBe(true)
        expect((yield* repository.history()).length).toBe(1)
        expect(new TextDecoder().decode(yield* repository.read("note"))).toBe("one")
      })
    )
  })

  it("allows only one stale-version contender to publish", async () => {
    await withRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.commit(changeSet([create("note", "note.md", "zero")], "seed"))
        const expectedVersion = (yield* requireVersion(repository, "note")).versionId
        const outcomes = yield* Effect.all(
          [1, 2].map((index) =>
            Effect.exit(
              repository.commit(
                changeSet(
                  [
                    new Update({
                      resourceId: "note",
                      expectedVersion,
                      content: encodeUtf8(`winner-${index}`)
                    })
                  ],
                  `contender-${index}`
                )
              )
            )
          ),
          { concurrency: 2 }
        )
        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
        expect(outcomes.filter(Exit.isFailure)).toHaveLength(1)
        expect(new TextDecoder().decode(yield* repository.read("note"))).toMatch(/^winner-[12]$/)
      })
    )
  })
})
