import { access } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { expect, it } from "vitest"

import { DataRoot, dataRootLayer } from "../src/runtime/data-root.js"

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
