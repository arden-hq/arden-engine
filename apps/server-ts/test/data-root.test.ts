import { access } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { expect, it } from "vitest"

import { DataRoot, dataRootLayer } from "../src/runtime/data-root.js"

it("keeps every file of a disk root beside the database", async () => {
  const root = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* DataRoot
    }).pipe(Effect.provide(dataRootLayer({ kind: "disk", databasePath: "/home/arden/arden.db" })))
  )
  expect(root).toEqual({
    dir: "/home/arden",
    databaseFile: "/home/arden/arden.db",
    databaseName: "arden.db",
    wiki: {
      workingRoot: "/home/arden/memory/wiki/pages",
      historyRoot: "/home/arden/memory/wiki/.wiki-history"
    },
    skills: "/home/arden/skills",
    globalInstructions: "/home/arden/AGENTS.md",
    conversations: "/home/arden/conversations",
    uploads: "/home/arden/uploads",
    research: "/home/arden/research",
    managedOutputs: "/home/arden/managed-outputs",
    computerPause: "/home/arden/computer-control.paused",
    computer: "/home/arden/computer"
  })
})

it("removes an ephemeral root when its scope closes", async () => {
  const root = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        dataRootLayer({ kind: "ephemeral", managedOutputRoot: "/outputs" }),
        scope
      )
      const root = Context.get(context, DataRoot)
      yield* Effect.promise(() => access(root.dir))
      yield* Scope.close(scope, Exit.void)
      return root
    })
  )
  expect(root).toMatchObject({
    databaseFile: ":memory:",
    databaseName: null,
    research: join(root.dir, "research"),
    managedOutputs: "/outputs"
  })
  await expect(access(root.dir)).rejects.toMatchObject({ code: "ENOENT" })
})
