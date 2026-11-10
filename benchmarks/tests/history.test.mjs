import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { importHistory, storesLayer } from "../history.mjs"
import { modelHost } from "../profile.mjs"
import { SessionQueries } from "../../apps/server-ts/dist/persistence/sessions/queries.js"
import { MemoryCaptureStore } from "../../apps/server-ts/dist/persistence/memory/store.js"

test("fixture import preserves supplied roles, text, dates and queues real memory capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-history-"))
  const databasePath = join(directory, "arden.db")
  const models = modelHost({
    model: "fixture",
    contextLimit: 32000,
    reasoningEffort: null
  })
  const source = {
    id: "history-1",
    date: "2025-01-02T12:00:00Z",
    messages: [
      { role: "user", content: "My project is Alpha." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "It is now called Beta." },
      { role: "assistant", content: "I will use Beta." }
    ]
  }
  try {
    const imported = await importHistory({ databasePath, models, history: [source] })
    const runtime = ManagedRuntime.make(storesLayer({ databasePath, models }))
    try {
      const observed = await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionQueries
          const captures = yield* MemoryCaptureStore
          return {
            snapshot: yield* sessions.load(imported[0].sessionId),
            pending: yield* captures.listPending()
          }
        })
      )
      assert.deepEqual(
        observed.snapshot.messages.map(({ role, content }) => ({ role, content })),
        source.messages
      )
      assert.ok(
        observed.snapshot.messages.every(
          (message) => message.created_at === "2025-01-02T12:00:00.000Z"
        )
      )
      assert.equal(observed.pending.length, 2)
    } finally {
      await runtime.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
