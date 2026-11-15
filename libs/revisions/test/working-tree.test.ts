import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Exit } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { RevisionStorageError, WorkingFileChangedError } from "../src/domain/errors.js"
import { encodeUtf8 } from "../src/domain/format.js"
import { ChangeSet, Create, Update } from "../src/domain/model.js"
import {
  ManagedFileRepository,
  type ManagedFileRepositoryShape,
  type WorkingFileChange
} from "../src/repository/service.js"
import { managedFileRepositoryNodeLayer } from "../src/storage/node.js"
import { present, requireVersion, useRepository } from "./kit.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "arden-working-tree-"))
  roots.push(root)
  return root
}

const create = (resources: ReadonlyArray<readonly [id: string, path: string, text: string]>) =>
  new ChangeSet({
    operations: resources.map(
      ([resourceId, path, text]) => new Create({ resourceId, path, content: encodeUtf8(text) })
    ),
    actor: "writer",
    origin: "test",
    reason: "create",
    idempotencyKey: `create-${resources.map(([id]) => id).join("-")}`
  })

const seeded = async (): Promise<string> => {
  const root = await tempRoot()
  await useRepository(root, (repository) =>
    repository.commit(
      create([
        ["a", "a.md", "one"],
        ["b", "notes/b.md", "two"],
        ["c", "notes/c.md", "three"],
        ["d", "d.md", "four"]
      ])
    )
  )
  return root
}

const adoption = { actor: "user:external", origin: "filesystem", reason: "outside" }

const summary = (change: WorkingFileChange) => {
  switch (change.kind) {
    case "changed":
      return {
        kind: change.kind,
        resourceId: change.resource.resourceId,
        text: new TextDecoder().decode(change.content)
      }
    case "missing":
      return { kind: change.kind, resourceId: change.resource.resourceId }
    case "unreadable":
      return { kind: change.kind, resourceId: change.resource.resourceId }
  }
}

const takeIn = (repository: ManagedFileRepositoryShape, resourceId: string) =>
  Effect.gen(function* () {
    const status = yield* repository.workingTreeStatus()
    const change = status.changes.find((item) => item.resource.resourceId === resourceId)
    if (change === undefined || change.kind === "unreadable")
      return yield* Effect.die(new Error(`expected an outside change to ${resourceId}`))
    return yield* repository.adoptWorkingChange(change, {
      ...adoption,
      expectedHead: status.revision
    })
  })

/** Every file under the history folder, so a test can see that a refused commit wrote nothing. */
const historyFiles = async (root: string): Promise<number> =>
  (await readdir(join(root, ".managed-history"), { recursive: true })).length

describe("working tree status", () => {
  it("reports every file's state and never fails because of one file", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")
    await rm(join(root, "notes"), { recursive: true })
    await unlink(join(root, "d.md"))
    await symlink(join(root, "a.md"), join(root, "d.md"))
    await writeFile(join(root, "new.md"), "untracked")
    await mkdir(join(root, "more"))
    await writeFile(join(root, "more", "other.txt"), "untracked")

    const status = await useRepository(root, (repository) => repository.workingTreeStatus())

    expect(status.changes.map(summary)).toEqual([
      { kind: "changed", resourceId: "a", text: "edited" },
      { kind: "missing", resourceId: "b" },
      { kind: "missing", resourceId: "c" },
      { kind: "unreadable", resourceId: "d" }
    ])
    expect(status.untracked.map((file) => [file.kind, file.path])).toEqual([
      ["listed", "more/other.txt"],
      ["listed", "new.md"]
    ])
  })

  it("reports a folder it cannot list and still finishes the scan", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")
    await mkdir(join(root, "locked"))
    await writeFile(join(root, "locked", "hidden.md"), "untracked")
    await chmod(join(root, "locked"), 0o000)
    try {
      const status = await useRepository(root, (repository) => repository.workingTreeStatus())
      expect(status.changes.map(summary)).toEqual([
        { kind: "changed", resourceId: "a", text: "edited" }
      ])
      expect(status.untracked.map((file) => [file.kind, file.path])).toEqual([
        ["unreadable", "locked"]
      ])
    } finally {
      await chmod(join(root, "locked"), 0o700)
    }
  })

  it("returns the content of the untracked files the caller asks for, and only those", async () => {
    const root = await seeded()
    await writeFile(join(root, "moved.md"), "one")
    await writeFile(join(root, "other.txt"), "not asked for")
    const status = await useRepository(root, (repository) =>
      repository.workingTreeStatus({ readUntracked: (path) => path.endsWith(".md") })
    )
    expect(
      status.untracked.map((file) =>
        file.kind === "read" ? [file.path, new TextDecoder().decode(file.content)] : [file.path]
      )
    ).toEqual([["moved.md", "one"], ["other.txt"]])
  })

  it("reads without creating the folder of a missing file", async () => {
    const root = await seeded()
    await rm(join(root, "notes"), { recursive: true })
    await useRepository(root, (repository) => repository.workingTreeStatus())
    await expect(readFile(join(root, "notes", "b.md"))).rejects.toThrow()
    await expect(mkdir(join(root, "notes"))).resolves.toBeUndefined()
  })
})

describe("a scan reads only files that may have changed", () => {
  const hourAgo = new Date(Date.now() - 3_600_000)
  const scan = (repository: ManagedFileRepositoryShape) =>
    repository.workingTreeStatus().pipe(Effect.map((status) => status.changes.map(summary)))

  it("does not read a file that kept its stamp since it matched history, until a full scan", async () => {
    const root = await seeded()
    await utimes(join(root, "a.md"), hourAgo, hourAgo)
    const outcome = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const first = yield* scan(repository)
        yield* Effect.promise(() => chmod(join(root, "a.md"), 0o000))
        const idle: Array<ReadonlyArray<unknown>> = []
        for (let index = 1; index < 60; index += 1) idle.push(yield* scan(repository))
        const full = yield* scan(repository)
        yield* Effect.promise(() => chmod(join(root, "a.md"), 0o644))
        return { first, idle: idle.filter((changes) => changes.length > 0).length, full }
      })
    )
    expect(outcome).toEqual({
      first: [],
      idle: 0,
      full: [{ kind: "unreadable", resourceId: "a" }]
    })
  })

  it("reads again a file whose size changed, even with its old time put back", async () => {
    const root = await seeded()
    await utimes(join(root, "a.md"), hourAgo, hourAgo)
    const changes = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        yield* scan(repository)
        yield* Effect.promise(async () => {
          await writeFile(join(root, "a.md"), "one more")
          await utimes(join(root, "a.md"), hourAgo, hourAgo)
        })
        return yield* scan(repository)
      })
    )
    expect(changes).toEqual([{ kind: "changed", resourceId: "a", text: "one more" }])
  })
})

describe("a commit checks only the files it touches", () => {
  it("writes one page while another page differs, is missing or is unreadable", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")
    await unlink(join(root, "notes", "b.md"))
    await unlink(join(root, "d.md"))
    await mkdir(join(root, "d.md"))

    const text = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const c = yield* requireVersion(repository, "c")
        yield* repository.commit(
          new ChangeSet({
            operations: [
              new Update({
                resourceId: "c",
                expectedVersion: c.versionId,
                content: encodeUtf8("3")
              })
            ],
            actor: "writer",
            origin: "test",
            reason: "update c",
            idempotencyKey: "update-c"
          })
        )
        return new TextDecoder().decode(yield* repository.read("c"))
      })
    )
    expect(text).toBe("3")
    expect(await readFile(join(root, "notes", "c.md"), "utf8")).toBe("3")
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("edited")
  })

  it("refuses to overwrite a page that changed outside, before writing anything", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")
    const before = await historyFiles(root)
    const refusal = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const a = yield* requireVersion(repository, "a")
        return yield* Effect.flip(
          repository.commit(
            new ChangeSet({
              operations: [
                new Update({
                  resourceId: "a",
                  expectedVersion: a.versionId,
                  content: encodeUtf8("mine")
                })
              ],
              actor: "writer",
              origin: "test",
              reason: "update a",
              idempotencyKey: "update-a"
            })
          )
        )
      })
    )
    expect(refusal).toBeInstanceOf(WorkingFileChangedError)
    expect(refusal).toMatchObject({ path: "a.md" })
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("edited")
    expect(await historyFiles(root)).toBe(before)
  })

  it("restores an archived page whose file is already back with the same bytes", async () => {
    const root = await seeded()
    const state = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const a = yield* requireVersion(repository, "a")
        yield* repository.commit({
          operations: [{ _tag: "Archive", resourceId: "a", expectedVersion: a.versionId }],
          actor: "writer",
          origin: "test",
          reason: "archive a"
        })
        yield* Effect.promise(() => writeFile(join(root, "a.md"), "one"))
        const archived = present(
          (yield* repository.listResources({ includeArchived: true })).find(
            (resource) => resource.resourceId === "a"
          ),
          "the archived page"
        )
        yield* repository.commit({
          operations: [{ _tag: "Restore", resourceId: "a", expectedVersion: archived.versionId }],
          actor: "writer",
          origin: "test",
          reason: "restore a"
        })
        return {
          a: (yield* repository.get("a"))?.state,
          changes: (yield* repository.workingTreeStatus()).changes.length
        }
      })
    )
    expect(state).toEqual({ a: "active", changes: 0 })
  })

  it("rolls back a stopped commit while another page differs outside", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited outside")
    const stopped = Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const d = yield* requireVersion(repository, "d")
      const exit = yield* Effect.exit(
        repository.commit(
          new ChangeSet({
            operations: [
              new Update({
                resourceId: "d",
                expectedVersion: d.versionId,
                content: encodeUtf8("4")
              })
            ],
            actor: "writer",
            origin: "test",
            reason: "update d",
            idempotencyKey: "update-d-stopped"
          })
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(
      Effect.provide(
        managedFileRepositoryNodeLayer({
          workingRoot: root,
          checkpoint: (stage) =>
            stage === "after_prepared"
              ? Effect.fail(new RevisionStorageError({ message: "simulated process stop" }))
              : Effect.void
        })
      )
    )
    await Effect.runPromise(stopped)
    const d = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        return new TextDecoder().decode(yield* repository.read("d"))
      })
    )
    expect(d).toBe("four")
    expect(await readFile(join(root, "d.md"), "utf8")).toBe("four")
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("edited outside")
    await expect(readdir(join(root, ".managed-history", "conflicts"))).resolves.toEqual([])
  })
})

describe("taking in one outside change", () => {
  it("records a changed file as one update and a missing file as one archive", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")
    await unlink(join(root, "notes", "b.md"))

    const result = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const updated = yield* takeIn(repository, "a")
        const archived = yield* takeIn(repository, "b")
        const status = yield* repository.workingTreeStatus()
        return {
          updated: updated.commit.changes.map((change) => change.action),
          archived: archived.commit.changes.map((change) => change.action),
          actor: archived.commit.actor,
          a: new TextDecoder().decode(yield* repository.read("a")),
          b: (yield* repository.get("b"))?.state,
          remaining: status.changes.length
        }
      })
    )
    expect(result).toEqual({
      updated: ["update"],
      archived: ["archive"],
      actor: "user:external",
      a: "edited",
      b: "archived",
      remaining: 0
    })
  })

  it("is refused when the head moved after the decision", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")

    const exit = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const status = yield* repository.workingTreeStatus()
        const change = present(status.changes[0], "the outside change")
        if (change.kind === "unreadable") return yield* Effect.die(new Error("unexpected"))
        const c = yield* requireVersion(repository, "c")
        yield* repository.commit(
          new ChangeSet({
            operations: [
              new Update({
                resourceId: "c",
                expectedVersion: c.versionId,
                content: encodeUtf8("3")
              })
            ],
            actor: "writer",
            origin: "test",
            reason: "update c",
            idempotencyKey: "update-c-during"
          })
        )
        return yield* Effect.exit(
          repository.adoptWorkingChange(change, { ...adoption, expectedHead: status.revision })
        )
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("edited")
  })

  it("is checked against that page's version, not the head the scan read", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")

    const text = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const status = yield* repository.workingTreeStatus()
        const change = present(status.changes[0], "the outside change")
        if (change.kind === "unreadable") return yield* Effect.die(new Error("unexpected"))
        const c = yield* requireVersion(repository, "c")
        yield* repository.commit(
          new ChangeSet({
            operations: [
              new Update({
                resourceId: "c",
                expectedVersion: c.versionId,
                content: encodeUtf8("3")
              })
            ],
            actor: "writer",
            origin: "test",
            reason: "update c",
            idempotencyKey: "update-c-between"
          })
        )
        yield* repository.adoptWorkingChange(change, {
          ...adoption,
          expectedHead: yield* repository.currentRevision
        })
        return new TextDecoder().decode(yield* repository.read("a"))
      })
    )
    expect(text).toBe("edited")
  })

  it("refuses a file that changed again after the scan", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")

    const exit = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const status = yield* repository.workingTreeStatus()
        const change = present(status.changes[0], "the outside change")
        if (change.kind === "unreadable") return yield* Effect.die(new Error("unexpected"))
        yield* Effect.promise(() => writeFile(join(root, "a.md"), "edited twice"))
        return yield* Effect.exit(
          repository.adoptWorkingChange(change, { ...adoption, expectedHead: status.revision })
        )
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("edited twice")
  })

  it("is refused when the file changes after the commit was prepared, and never overwritten", async () => {
    const root = await seeded()
    await writeFile(join(root, "a.md"), "edited")

    const stopped = Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const exit = yield* Effect.exit(takeIn(repository, "a"))
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(
      Effect.provide(
        managedFileRepositoryNodeLayer({
          workingRoot: root,
          checkpoint: (stage) =>
            stage === "after_prepared"
              ? Effect.promise(() => writeFile(join(root, "a.md"), "edited twice"))
              : Effect.void
        })
      )
    )
    await Effect.runPromise(stopped)

    const state = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const head = present(yield* repository.head, "a head")
        return {
          actions: (yield* repository.inspectCommit(head)).changes.map((change) => change.action),
          a: new TextDecoder().decode(yield* repository.read("a"))
        }
      })
    )
    expect(state).toEqual({ actions: ["create", "create", "create", "create"], a: "one" })
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("edited twice")
  })

  it("finishes an archive that stopped before its ref moved", async () => {
    const root = await seeded()
    await unlink(join(root, "notes", "b.md"))

    const stopped = Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const exit = yield* Effect.exit(takeIn(repository, "b"))
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(
      Effect.provide(
        managedFileRepositoryNodeLayer({
          workingRoot: root,
          checkpoint: (stage) =>
            stage === "after_prepared"
              ? Effect.fail(new RevisionStorageError({ message: "simulated process stop" }))
              : Effect.void
        })
      )
    )
    await Effect.runPromise(stopped)

    const state = await useRepository(root, (repository) =>
      Effect.gen(function* () {
        const head = present(yield* repository.head, "a head")
        const commit = yield* repository.inspectCommit(head)
        return {
          actions: commit.changes.map((change) => change.action),
          b: (yield* repository.get("b"))?.state,
          changes: (yield* repository.workingTreeStatus()).changes.length
        }
      })
    )
    expect(state).toEqual({ actions: ["archive"], b: "archived", changes: 0 })
  })
})
