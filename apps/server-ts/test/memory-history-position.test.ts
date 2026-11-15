import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { Effect } from "effect"
import { expect, it } from "vitest"

import { WikiEventOutbox } from "../src/persistence/automations/wiki-event-outbox.js"
import { WikiMaintenanceStore } from "../src/persistence/wiki-maintenance/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const A = "a".repeat(64)
const B = "b".repeat(64)
const C = "c".repeat(64)

it("moves each reader's place only from where it stands", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const outbox = yield* WikiEventOutbox
      const maintenance = yield* WikiMaintenanceStore
      const started = {
        publication: yield* outbox.wikiPublicationCursor(A),
        maintenance: yield* maintenance.initialize(A)
      }
      const restarted = {
        publication: yield* outbox.wikiPublicationCursor(C),
        maintenance: yield* maintenance.initialize(C)
      }
      const published = yield* outbox.publishWikiChange({
        previousRevision: A,
        revision: B,
        event: undefined
      })
      const publishedTwice = yield* outbox.publishWikiChange({
        previousRevision: A,
        revision: B,
        event: undefined
      })
      const publishedStale = yield* outbox.publishWikiChange({
        previousRevision: C,
        revision: A,
        event: undefined
      })
      const reviewed = yield* maintenance.compareAndSet({ expected: A, next: B })
      const reviewedTwice = yield* maintenance.compareAndSet({ expected: A, next: B })
      const reviewedStale = yield* Effect.flip(maintenance.compareAndSet({ expected: C, next: A }))
      return {
        started,
        restarted,
        published,
        publishedTwice,
        publishedStale,
        publication: yield* outbox.wikiPublicationCursor(null),
        reviewed,
        reviewedTwice,
        reviewedStale: reviewedStale.reason,
        maintenance: yield* maintenance.processedHead()
      }
    })
  )
  expect(result).toEqual({
    started: { publication: A, maintenance: A },
    restarted: { publication: A, maintenance: A },
    published: { queued: 0 },
    publishedTwice: null,
    publishedStale: null,
    publication: B,
    reviewed: B,
    reviewedTwice: B,
    reviewedStale: "conflict",
    maintenance: B
  })
})

const SOURCE = join(import.meta.dirname, "../src")
const HELPER = "persistence/sqlite/memory-history-position.ts"

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

it("writes either place only in the helper", () => {
  const writers = sources(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => !path.startsWith("persistence/migrations/"))
    .filter((path) => {
      const text = readFileSync(join(SOURCE, path), "utf8")
      return /monitor_state/u.test(text) && /wiki_publication|wiki_maintenance/u.test(text)
    })
  expect(writers).toEqual([HELPER])
})
