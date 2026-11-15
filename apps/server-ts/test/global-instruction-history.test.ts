import { Effect, Layer } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

import { GlobalInstructions, globalInstructionsLayer } from "../src/context/global-instructions.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const CHAT = { kind: "chat", chat: { sessionId: "session-1", runId: "run-1" } } as const
const RESTORE = {
  kind: "restore",
  chat: { sessionId: "session-1", runId: "run-2" },
  from: 1
} as const

it("records each change with its writer, adopts an outside edit as the owner's, and restores", async () => {
  const folder = await mkdtemp(join(tmpdir(), "arden-rules-"))
  try {
    const file = join(folder, "AGENTS.md")
    await writeFile(file, "Rule one.\n")
    const history = await withTempDatabase(
      Effect.gen(function* () {
        const rules = yield* GlobalInstructions
        const first = yield* rules.read()
        yield* rules.replace({
          content: "Rule one.\nRule two.",
          expectedVersion: first.version,
          writer: CHAT
        })
        yield* Effect.promise(() => writeFile(file, "Rule three, typed in an editor.\n"))
        const outside = yield* rules.read()
        yield* rules.replace({
          content: (yield* rules.version(1))?.content ?? "",
          expectedVersion: outside.version,
          writer: RESTORE
        })
        return yield* rules.versions({ limit: 10 })
      }).pipe(Effect.provide(Layer.fresh(globalInstructionsLayer(file))))
    )
    expect(history.versions.map((version) => [version.version, version.writer])).toEqual([
      [4, RESTORE],
      [3, { kind: "outside" }],
      [2, CHAT],
      [1, { kind: "seed" }]
    ])
    expect(await readFile(file, "utf8")).toBe("Rule one.\n")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
