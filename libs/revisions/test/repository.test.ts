import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Exit, Fiber, Layer } from "effect"
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

  it("rejects stale per-resource versions", async () => {
    await withRepository((repository) =>
      Effect.gen(function* () {
        const first = yield* repository.commit(
          new ChangeSet({
            operations: [
              new Create({ resourceId: "note", path: "note.md", content: encodeUtf8("one") })
            ],
            actor: "alice",
            origin: "test",
            reason: "create",
            idempotencyKey: "cas-1",
            expectedHead: null,
            enforceExpectedHead: false
          })
        )
        const version = yield* requireVersion(repository, "note")
        expect(version).not.toBeNull()
        const stale = new Update({
          resourceId: "note",
          expectedVersion: "0".repeat(64),
          content: encodeUtf8("two")
        })
        const failure = yield* Effect.exit(
          repository.commit(
            new ChangeSet({
              operations: [stale],
              actor: "alice",
              origin: "test",
              reason: "stale",
              idempotencyKey: "cas-2",
              expectedHead: first.commit.commitId,
              enforceExpectedHead: true
            })
          )
        )
        expect(failure._tag).toBe("Failure")
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
  })

  it("reads the published parent while a commit sits between its ref swap and its publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "arden-revisions-"))
    roots.push(root)
    const window: { reader?: ManagedFileRepositoryShape; seen?: readonly string[] } = {}
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        window.reader = repository
        const first = yield* repository.commit(
          new ChangeSet({
            operations: [
              new Create({ resourceId: "note", path: "note.md", content: encodeUtf8("one") })
            ],
            actor: "alice",
            origin: "test",
            reason: "create",
            idempotencyKey: "window-1",
            expectedHead: null,
            enforceExpectedHead: false
          })
        )
        yield* repository.commit(
          new ChangeSet({
            operations: [
              new Create({ resourceId: "other", path: "other.md", content: encodeUtf8("two") })
            ],
            actor: "alice",
            origin: "test",
            reason: "create",
            idempotencyKey: "window-2",
            expectedHead: first.commit.commitId,
            enforceExpectedHead: false
          })
        )
        expect(window.seen).toEqual(["note"])
        return (yield* repository.listResources()).map((resource) => resource.resourceId)
      }).pipe(
        Effect.provide(
          managedFileRepositoryNodeLayer({
            workingRoot: root,
            checkpoint: (stage) =>
              stage !== "after_ref" || window.reader === undefined
                ? Effect.void
                : window.reader.listResources().pipe(
                    Effect.map((resources) => {
                      if (window.seen === undefined && resources.length > 0)
                        window.seen = resources.map((resource) => resource.resourceId)
                    })
                  )
          })
        )
      )
    )
    expect(seen).toEqual(["note", "other"])
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

  it("an open interrupted at any point releases the repository lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "arden-revisions-"))
    roots.push(root)
    const nextTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
    let opened = false
    for (let ticks = 0; !opened && ticks < 2_000; ticks++) {
      opened = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Layer.build(managedFileRepositoryNodeLayer({ workingRoot: root })).pipe(Effect.scoped)
          )
          yield* nextTick.pipe(Effect.repeat({ times: ticks }))
          yield* Fiber.interrupt(fiber)
          return Exit.isSuccess(yield* Fiber.await(fiber))
        })
      )
      await useRepository(root, () => Effect.void)
    }
    expect(opened).toBe(true)
  })
})
