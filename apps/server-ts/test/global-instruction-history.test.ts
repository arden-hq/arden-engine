import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256Hex } from "@arden-hq/std/hash"
import { expect, it } from "vitest"

import { GlobalInstructions, globalInstructionsLayer } from "../src/context/global-instructions.js"
import {
  type InstructionVersion,
  InstructionVersionStore,
  InstructionVersionStoreError
} from "../src/persistence/instructions/store.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { deleteSessionOwnedData } from "../src/persistence/sqlite/session-deletion.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Every change to the standing rules is a version with its writer and time. The rules file stays
// the live copy; the versions are the history the rules tools list and restore from.

const CHAT = { kind: "chat", chat: { sessionId: "session-1", runId: "run-1" } } as const
const RESTORE = {
  kind: "restore",
  chat: { sessionId: "session-1", runId: "run-2" },
  from: 1
} as const

const withRulesFolder = async <A>(use: (folder: string) => Promise<A>): Promise<A> => {
  const folder = await mkdtemp(join(tmpdir(), "arden-rules-"))
  try {
    return await use(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

const causes = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${causes(error.cause)}` : String(error)

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
            writer: RESTORE
          })
          return { changed, restored, history: yield* rules.versions({ limit: 10 }) }
        })
      )
    )
    expect(result.history.total).toBe(4)
    expect(result.history.versions.map((version) => version.writer)).toEqual([
      RESTORE,
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

it("drops a version's chat when that chat is deleted, and keeps its text", async () => {
  const latest = await withTempDatabase(
    Effect.gen(function* () {
      const store = yield* InstructionVersionStore
      yield* store.append({ content: "Rule one.", digest: "d1", writer: CHAT })
      const sql = yield* SqlClient.SqlClient
      const events = yield* SessionLifecycleEvents
      yield* sql.withTransaction(deleteSessionOwnedData(sql, events, "session-1"))
      return yield* store.latest()
    })
  )
  expect(latest).toMatchObject({ content: "Rule one.", writer: { kind: "chat", chat: undefined } })
})

it("lets a version be forgotten, keeps every text unchanged, and never reuses a number", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const store = yield* InstructionVersionStore
      const sql = yield* SqlClient.SqlClient
      yield* store.append({ content: "Rule one.", digest: "d1", writer: { kind: "seed" } })
      yield* store.append({ content: "A secret.", digest: "d2", writer: CHAT })
      yield* sql`DELETE FROM global_instruction_versions WHERE version = 2`
      const next = yield* store.append({ content: "Rule two.", digest: "d3", writer: CHAT })
      const rewrite = yield* sql`UPDATE global_instruction_versions SET content = 'x'`.pipe(
        Effect.flip
      )
      const relink = yield* sql`UPDATE global_instruction_versions SET session_id = 'other'
        WHERE version = 3`.pipe(Effect.flip)
      return { next, rewrite, relink, listed: yield* store.list({ limit: 10 }) }
    })
  )
  expect(result.next.version).toBe(3)
  expect(result.listed.total).toBe(2)
  expect(result.listed.versions.map((version) => version.version)).toEqual([3, 1])
  expect(causes(result.rewrite)).toContain("immutable")
  expect(causes(result.relink)).toContain("only loses its chat")
})

/** A history store in memory whose writes can be made to fail, as a locked database would. */
const flakyStore = () => {
  const rows: Array<InstructionVersion> = []
  const state = { failing: false }
  const store = InstructionVersionStore.of({
    latest: () => Effect.succeed(rows.at(-1)),
    get: (version) => Effect.succeed(rows.find((row) => row.version === version)),
    list: ({ limit }) =>
      Effect.succeed({ versions: rows.toReversed().slice(0, limit), total: rows.length }),
    append: ({ content, digest, writer }) => {
      if (state.failing)
        return Effect.fail(
          new InstructionVersionStoreError({
            operation: "append",
            reason: "storage",
            message: "database is locked"
          })
        )
      const row = { version: rows.length + 1, content, digest, writer, recordedAt: "now" }
      rows.push(row)
      return Effect.succeed(row)
    }
  })
  return { rows, state, layer: Layer.succeed(InstructionVersionStore, store) }
}

const startedOver = <A, E>(
  file: string,
  store: ReturnType<typeof flakyStore>,
  body: Effect.Effect<A, E, GlobalInstructions>
) =>
  Effect.runPromise(
    body.pipe(Effect.provide(globalInstructionsLayer(file).pipe(Layer.provide(store.layer))))
  )

it("keeps loading and changing the rules when the history cannot be written", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    await writeFile(file, "Rule one.\n")
    const store = flakyStore()
    store.state.failing = true
    const loaded = await startedOver(
      file,
      store,
      Effect.gen(function* () {
        const rules = yield* GlobalInstructions
        const first = yield* rules.read()
        yield* rules.replace({
          content: "Rule one.\nRule two.",
          expectedVersion: first.version,
          writer: CHAT
        })
        return yield* rules.read()
      })
    )
    expect(loaded.content).toBe("Rule one.\nRule two.")
    expect(store.rows).toEqual([])
  })
})

it("records a change the history missed under its own writer, not as an outside edit", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    await writeFile(file, "Rule one.\n")
    const store = flakyStore()
    await startedOver(
      file,
      store,
      Effect.gen(function* () {
        const rules = yield* GlobalInstructions
        const first = yield* rules.read()
        store.state.failing = true
        yield* rules.replace({
          content: "Rule one.\nRule two.",
          expectedVersion: first.version,
          writer: CHAT
        })
        store.state.failing = false
        yield* rules.read()
      })
    )
    expect(store.rows.map((row) => row.writer)).toEqual([{ kind: "seed" }, CHAT])
  })
})

it("records an outside edit a change replaces before any read", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    await writeFile(file, "Rule one.\n")
    const store = flakyStore()
    await startedOver(
      file,
      store,
      Effect.gen(function* () {
        const rules = yield* GlobalInstructions
        const edited = "Rule three, typed in an editor.\n"
        yield* Effect.promise(() => writeFile(file, edited))
        yield* rules.replace({
          content: "Rule four.",
          expectedVersion: sha256Hex(Buffer.from(edited)),
          writer: CHAT
        })
      })
    )
    expect(store.rows.map((row) => row.writer.kind)).toEqual(["seed", "outside", "chat"])
  })
})

it("can restore every version it can record, up to the size limit", async () => {
  await withRulesFolder(async (folder) => {
    const file = join(folder, "AGENTS.md")
    const largest = "x".repeat(128 * 1024)
    await writeFile(file, largest)
    const store = flakyStore()
    const after = await startedOver(
      file,
      store,
      Effect.gen(function* () {
        const rules = yield* GlobalInstructions
        const current = yield* rules.read()
        const cleared = yield* rules.replace({
          content: "",
          expectedVersion: current.version,
          writer: CHAT
        })
        yield* rules.replace({
          content: (yield* rules.version(1))?.content ?? "",
          expectedVersion: cleared.version,
          writer: { kind: "restore", chat: CHAT.chat, from: 1 }
        })
        return yield* rules.read()
      })
    )
    expect(after.content).toBe(largest)
    expect(store.rows.map((row) => row.writer.kind)).toEqual(["seed", "chat", "restore"])
  })
})
