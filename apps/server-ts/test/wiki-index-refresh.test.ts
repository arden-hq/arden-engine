import { Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { expect, it } from "vitest"

import { EmbeddingModel } from "../src/embedding/model.js"
import { EmbeddingModels } from "../src/embedding/models.js"
import { WikiEmbeddingIndex, wikiEmbeddingIndexLayer } from "../src/embedding/wiki-index.js"
import {
  WikiEmbeddingStore,
  WikiEmbeddingStoreError
} from "../src/persistence/memory/embedding-store.js"
import { EmbeddingSettingsStore } from "../src/persistence/settings/store.js"
import { wikiError } from "../src/wiki/errors.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { Wiki } from "../src/wiki/service.js"
import { snapshotOf, type PageRecord, type Snapshot } from "../src/wiki/snapshot.js"
import { partialService } from "./kit.js"

const record = (pageId: string, version: string): PageRecord => ({
  resource: {
    resourceId: pageId,
    path: `${pageId}.md`,
    blobId: version,
    state: "active",
    versionId: version
  },
  page: Effect.runSync(
    parseWikiPage(
      formatWikiPage({
        pageId,
        title: pageId,
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata: {},
        body: `About ${pageId}.\n`
      }),
      pageId
    )
  )
})

const version = (digit: string) => digit.repeat(64)

const snapshot = (head: string, pages: ReadonlyArray<readonly [string, string]>): Snapshot =>
  snapshotOf(
    version(head),
    pages.map(([pageId, digit]) => record(pageId, version(digit)))
  )

const START = snapshot("1", [["a", "a"]])
const MOVED = snapshot("2", [
  ["a", "b"],
  ["c", "c"],
  ["forgotten", "e"]
])
const AGAIN = snapshot("3", [
  ["a", "b"],
  ["c", "d"],
  ["forgotten", "f"]
])

const SERVING = [
  {
    indexVersion: "fake-1",
    modelId: "fake",
    dimensions: 2,
    role: "serving" as const,
    startedAt: "2026-11-15T00:00:00.000Z"
  }
]

const model = EmbeddingModel.of({
  modelId: "fake",
  indexVersion: "fake-1",
  dimensions: 2,
  batchSize: 8,
  chunkDocument: (document) => Effect.succeed([{ text: document.body, excerpt: document.body }]),
  embed: (texts) => Effect.succeed(texts.map(() => new Float32Array([1, 0])))
})

const indexLayer = (memory: {
  readonly stored: Map<string, string>
  readonly indexes: WikiEmbeddingStore["Service"]["indexes"]
  readonly snapshot: Wiki["Service"]["snapshot"]
}) =>
  wikiEmbeddingIndexLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          EmbeddingModels,
          partialService<EmbeddingModels["Service"]>("EmbeddingModels", {
            catalog: () =>
              Effect.succeed([{ modelId: "fake", indexVersion: "fake-1", dimensions: 2 }]),
            use: () => Effect.succeed(model),
            release: () => Effect.void
          })
        ),
        Layer.succeed(
          WikiEmbeddingStore,
          partialService<WikiEmbeddingStore["Service"]>("WikiEmbeddingStore", {
            indexes: memory.indexes,
            drop: () => Effect.void,
            pages: () =>
              Effect.sync(() =>
                [...memory.stored].map(([pageId, pageVersion]) => ({ pageId, pageVersion }))
              ),
            deletePages: (_, pageIds) =>
              Effect.sync(() => pageIds.forEach((pageId) => memory.stored.delete(pageId))),
            replacePage: (write) =>
              Effect.sync(() => void memory.stored.set(write.pageId, write.pageVersion))
          })
        ),
        Layer.succeed(
          EmbeddingSettingsStore,
          partialService<EmbeddingSettingsStore["Service"]>("EmbeddingSettingsStore", {
            settings: () => Effect.succeed({ modelId: "fake", keepIndex: true, paused: false })
          })
        ),
        Layer.succeed(Wiki, partialService<Wiki["Service"]>("Wiki", { snapshot: memory.snapshot }))
      )
    )
  )

const versions = (current: Snapshot) =>
  Object.fromEntries(
    current.pages
      .filter((page) => page.page.pageId !== "forgotten")
      .map((page) => [page.page.pageId, page.resource.versionId])
  )

it("follows Memory from the poll: once per new head, and again after a failed refresh", async () => {
  const stored = new Map<string, string>()
  let refreshes = 0
  let failNext = false
  const layer = indexLayer({
    stored,
    indexes: () =>
      Effect.suspend(() => {
        refreshes += 1
        if (!failNext) return Effect.succeed(SERVING)
        failNext = false
        return Effect.fail(
          new WikiEmbeddingStoreError({ operation: "indexes", message: "made to fail" })
        )
      }),
    snapshot: () => Effect.succeed(START)
  })
  const indexed = () => Object.fromEntries(stored)

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const index = yield* WikiEmbeddingIndex
        yield* index.drained()
        const atStart = { indexed: indexed(), refreshes }
        yield* index.schedule(START)
        yield* index.drained()
        const sameHead = refreshes
        yield* index.schedule(MOVED)
        yield* index.drained()
        const moved = indexed()
        failNext = true
        yield* index.schedule(AGAIN)
        yield* index.drained()
        const failed = indexed()
        yield* index.schedule(AGAIN)
        yield* index.drained()
        return { atStart, sameHead, moved, failed, again: indexed() }
      }).pipe(Effect.provide(layer))
    )
  )
  expect(result).toEqual({
    atStart: { indexed: versions(START), refreshes: 1 },
    sameHead: 1,
    moved: versions(MOVED),
    failed: versions(MOVED),
    again: versions(AGAIN)
  })
})

it("stays busy while a refresh runs, even when the first read of Memory fails meanwhile", async () => {
  const stored = new Map<string, string>()
  const firstRead = Deferred.makeUnsafe<void>()
  const firstReadFailed = Deferred.makeUnsafe<void>()
  const refreshStarted = Deferred.makeUnsafe<void>()
  const refreshMayFinish = Deferred.makeUnsafe<void>()
  const layer = indexLayer({
    stored,
    indexes: () =>
      Deferred.succeed(refreshStarted, undefined).pipe(
        Effect.andThen(Deferred.await(refreshMayFinish)),
        Effect.as(SERVING)
      ),
    snapshot: () =>
      Deferred.await(firstRead).pipe(
        Effect.andThen(Effect.fail(wikiError("list", "storage", "made to fail")))
      )
  })
  const noticeFirstReadFailed = Logger.make((options) => {
    if (String(options.message).includes("Initial Wiki embedding refresh failed"))
      Deferred.doneUnsafe(firstReadFailed, Exit.void)
  })

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const index = yield* WikiEmbeddingIndex
        yield* index.schedule(MOVED)
        yield* Deferred.await(refreshStarted)
        const waiting = yield* Effect.forkChild(index.drained())
        yield* Deferred.succeed(firstRead, undefined)
        yield* Deferred.await(firstReadFailed)
        for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow
        const drainedWhileRefreshing = waiting.pollUnsafe() !== undefined
        yield* Deferred.succeed(refreshMayFinish, undefined)
        yield* Fiber.join(waiting)
        return { drainedWhileRefreshing, indexed: Object.fromEntries(stored) }
      }).pipe(Effect.provide(layer))
    ).pipe(Effect.provide(Logger.layer([noticeFirstReadFailed])))
  )
  expect(result).toEqual({ drainedWhileRefreshing: false, indexed: versions(MOVED) })
})
