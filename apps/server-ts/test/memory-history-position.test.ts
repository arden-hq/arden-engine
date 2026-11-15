import { Effect } from "effect"
import { expect, it } from "vitest"

import { WikiEventOutbox } from "../src/persistence/automations/wiki-event-outbox.js"
import { WikiMaintenanceStore } from "../src/persistence/wiki-maintenance/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const [A, B, C] = ["a", "b", "c"].map((letter) => letter.repeat(64)) as [string, string, string]

it("moves each reader's place only from where it stands", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const outbox = yield* WikiEventOutbox
      const maintenance = yield* WikiMaintenanceStore
      yield* outbox.wikiPublicationCursor(A)
      yield* maintenance.initialize(A)
      const publish = (previousRevision: string, revision: string) =>
        outbox.publishWikiChange({ previousRevision, revision, event: undefined })
      const published = [yield* publish(A, B), yield* publish(A, B), yield* publish(C, A)]
      const reviewed = [
        yield* maintenance.compareAndSet({ expected: A, next: B }),
        yield* maintenance.compareAndSet({ expected: A, next: B }),
        (yield* Effect.flip(maintenance.compareAndSet({ expected: C, next: A }))).reason
      ]
      return {
        published,
        publication: yield* outbox.wikiPublicationCursor(null),
        reviewed,
        maintenance: yield* maintenance.processedHead()
      }
    })
  )
  expect(result).toEqual({
    published: [{ queued: 0 }, null, null],
    publication: B,
    reviewed: [B, B, "conflict"],
    maintenance: B
  })
})
