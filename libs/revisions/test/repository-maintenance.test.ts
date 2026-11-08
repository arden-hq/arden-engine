import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Context, Effect, Exit, Layer, Scope } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { encodeUtf8 } from "../src/domain/format.js"
import { ChangeSet, Create } from "../src/domain/model.js"
import { ManagedFileRepository } from "../src/repository/service.js"
import { managedFileRepositoryNodeLayer } from "../src/storage/node.js"
import { sha256Hex } from "@arden-hq/std/hash"

const roots: string[] = []
const scopes: Scope.Closeable[] = []

afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void)))
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const openRepository = async (
  root: string,
  gcGracePeriodMs = 0
): Promise<ManagedFileRepository["Service"]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      scopes.push(scope)
      const context = yield* Layer.buildWithScope(
        managedFileRepositoryNodeLayer({ workingRoot: root, gcGracePeriodMs }),
        scope
      )
      return Context.get(context, ManagedFileRepository)
    })
  )

describe("repository maintenance facade", () => {
  it.each(["note.md", `${Array.from({ length: 64 }, () => "d").join("/")}/note.md`])(
    "reports live state and collects unreachable objects for %s",
    async (path) => {
      const root = await mkdtemp(join(tmpdir(), "arden-revisions-maintenance-"))
      roots.push(root)
      const repository = await openRepository(root)
      await Effect.runPromise(
        repository.commit(
          new ChangeSet({
            operations: [new Create({ resourceId: "note", path, content: encodeUtf8("live\n") })],
            actor: "tester",
            origin: "maintenance-test",
            reason: "seed",
            idempotencyKey: "seed",
            expectedHead: null,
            enforceExpectedHead: false
          })
        )
      )

      const integrity = await Effect.runPromise(repository.integrityReport)
      const storage = await Effect.runPromise(repository.storageReport)
      expect(integrity.issues).toEqual([])
      expect(integrity.ok).toBe(true)
      expect(integrity.resources).toBe(1)
      expect(storage.resourceCount).toBe(1)
      expect(storage.commitCount).toBe(1)

      const orphan = encodeUtf8("unreachable\n")
      const orphanId = sha256Hex(orphan)
      await writeFile(join(root, ".managed-history", "objects", "blobs", orphanId), orphan)
      const collected = await Effect.runPromise(
        repository.collect({
          gracePeriodMs: 0,
          nowMillis: Date.now() + 10_000
        })
      )
      expect(collected.removed).toBe(1)
      expect(collected.bytesRemoved).toBe(orphan.length)
      expect((await Effect.runPromise(repository.integrityReport)).ok).toBe(true)
    }
  )
})
