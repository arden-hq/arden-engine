import { Effect, Layer } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

import { GlobalInstructions, globalInstructionsLayer } from "../src/context/global-instructions.js"
import { InstructionVersionStore } from "../src/persistence/instructions/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Every change to the standing rules is a version with its writer and time. The rules file stays
// the live copy; the versions are the history the rules tools list and restore from.

const CHAT = { kind: "chat", sessionId: "session-1", runId: "run-1" } as const

const withRulesFolder = async <A>(use: (folder: string) => Promise<A>): Promise<A> => {
  const folder = await mkdtemp(join(tmpdir(), "arden-rules-"))
  try {
    return await use(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** Starts the rules service over `file`, the way the server does at each start. */
const started = <A, E, R>(file: string, body: Effect.Effect<A, E, R | GlobalInstructions>) =>
  body.pipe(Effect.provide(Layer.fresh(globalInstructionsLayer(file))))

it("seeds the rules as version one on the first start, and only then", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    await writeFile(file, "Answer in English.\n")
    const versions = await withTempDatabase(
      Effect.gen(function* () {
        yield* started(file, Effect.void)
        yield* started(file, Effect.void)
        return yield* (yield* InstructionVersionStore).list({ limit: 10 })
      })
    )
    expect(versions.total).toBe(1)
    expect(versions.versions[0]).toMatchObject({
      version: 1,
      content: "Answer in English.",
      writer: { kind: "seed" }
    })
  })
})

it("seeds the rules moved from directives.json", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    await writeFile(join(folder, "directives.json"), JSON.stringify({ content: "Be brief." }))
    const latest = await withTempDatabase(
      Effect.gen(function* () {
        yield* started(file, Effect.void)
        return yield* (yield* InstructionVersionStore).latest()
      })
    )
    expect(latest).toMatchObject({ version: 1, content: "Be brief.", writer: { kind: "seed" } })
  })
})

it("records each change with its writer, adopts an outside edit as the owner's, and restores", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    await writeFile(file, "Rule one.\n")
    const result = await withTempDatabase(
      started(
        file,
        Effect.gen(function* () {
          const rules = yield* GlobalInstructions
          const first = yield* rules.read()
          const changed = yield* rules.replace({
            content: "Rule one.\nRule two.",
            expectedVersion: first.version,
            writer: CHAT
          })
          yield* Effect.promise(() => writeFile(file, "Rule three, typed in an editor.\n"))
          const outside = yield* rules.read()
          const restored = yield* rules.replace({
            content: (yield* rules.version(1))?.content ?? "",
            expectedVersion: outside.version,
            writer: { kind: "restore", sessionId: "session-1", runId: "run-2", from: 1 }
          })
          return { changed, restored, history: yield* rules.versions({ limit: 10 }) }
        })
      )
    )
    expect(result.history.total).toBe(4)
    expect(result.history.versions.map((version) => version.writer)).toEqual([
      { kind: "restore", sessionId: "session-1", runId: "run-2", from: 1 },
      { kind: "outside" },
      CHAT,
      { kind: "seed" }
    ])
    expect(result.history.versions.map((version) => version.version)).toEqual([4, 3, 2, 1])
    expect(result.history.versions[0]?.digest).toBe(result.restored.version)
    expect(result.history.versions[2]?.digest).toBe(result.changed.version)
    expect(await readFile(file, "utf8")).toBe("Rule one.\n")
  })
})

it("records nothing when a change leaves the rules as they are", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    await writeFile(file, "Rule one.\n")
    const total = await withTempDatabase(
      started(
        file,
        Effect.gen(function* () {
          const rules = yield* GlobalInstructions
          const current = yield* rules.read()
          yield* rules.replace({
            content: "Rule one.",
            expectedVersion: current.version,
            writer: CHAT
          })
          yield* rules.read()
          return (yield* rules.versions({ limit: 10 })).total
        })
      )
    )
    expect(total).toBe(1)
  })
})
