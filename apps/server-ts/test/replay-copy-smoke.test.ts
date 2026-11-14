import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { StoragePolicyStore } from "../src/persistence/storage/store.js"
import { locateReplayCopy, runOnReplayCopy } from "./fixtures/replay-copy.js"

// An earlier replay lost 48 trials because every save on the copy was refused
// and nothing said so. Every replay batch starts here: one write through the
// engine's own store, read back through the store and from the file itself.

const located = locateReplayCopy()

it("writes to the replay copy through the engine and reads the write back", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const { copy } = located
  const onDisk = () => {
    const database = new DatabaseSync(copy.database, { readOnly: true })
    try {
      return database
        .prepare("SELECT wiki_history_days FROM storage_retention WHERE singleton_id = 1")
        .get()?.wiki_history_days
    } finally {
      database.close()
    }
  }
  const trial = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const policy = yield* StoragePolicyStore
      const original = yield* policy.retention()
      // Ten years trims nothing in this history, should a later run keep it.
      const probe = {
        ...original,
        wikiHistoryDays: original.wikiHistoryDays === 3650 ? 3649 : 3650
      }
      yield* policy.updateRetention(probe)
      const readBack = yield* policy.retention()
      const committed = onDisk()
      yield* policy.updateRetention(original)
      const restored = yield* policy.retention()
      return { original, probe, readBack, committed, restored, restoredOnDisk: onDisk() }
    })
  )
  expect(trial.readBack, "the store refused the write or lost it").toEqual(trial.probe)
  expect(trial.committed, "the write never reached the file").toBe(trial.probe.wikiHistoryDays)
  expect(trial.restored).toEqual(trial.original)
  expect(trial.restoredOnDisk).toBe(trial.original.wikiHistoryDays)
}, 600_000)
