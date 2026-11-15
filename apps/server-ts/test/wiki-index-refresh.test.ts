import { Effect, Layer } from "effect"
import { expect, it } from "vitest"

import { EmbeddingModel } from "../src/embedding/model.js"
import { EmbeddingModels } from "../src/embedding/models.js"
import { WikiEmbeddingIndex, wikiEmbeddingIndexLayer } from "../src/embedding/wiki-index.js"
import {
  WikiEmbeddingStore,
  WikiEmbeddingStoreError
} from "../src/persistence/memory/embedding-store.js"
import { EmbeddingSettingsStore } from "../src/persistence/settings/store.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { Wiki } from "../src/wiki/service.js"
import type { PageRecord, Snapshot } from "../src/wiki/snapshot.js"
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

const snapshot = (head: string, pages: ReadonlyArray<readonly [string, string]>): Snapshot => ({
  head: version(head),
  pages: pages.map(([pageId, digit]) => record(pageId, version(digit)))
})

const START = snapshot("1", [["a", "a"]])
// forgotten.md is the code-owned page of what the owner asked to forget; nothing embeds it.
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

it("follows Memory from the poll: once per new head, and again after a failed refresh", async () => {
  const stored = new Map<string, string>()
  let refreshes = 0
  let failNext = false
  const model = EmbeddingModel.of({
    modelId: "fake",
    indexVersion: "fake-1",
    dimensions: 2,
    batchSize: 8,
    chunkDocument: (document) => Effect.succeed([{ text: document.body, excerpt: document.body }]),
    embed: (texts) => Effect.succeed(texts.map(() => new Float32Array([1, 0])))
  })
  const layer = wikiEmbeddingIndexLayer.pipe(
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
            indexes: () =>
              Effect.suspend(() => {
                refreshes += 1
                if (!failNext)
                  return Effect.succeed([
                    {
                      indexVersion: "fake-1",
                      modelId: "fake",
                      dimensions: 2,
                      role: "serving" as const,
                      startedAt: "2026-11-15T00:00:00.000Z"
                    }
                  ])
                failNext = false
                return Effect.fail(
                  new WikiEmbeddingStoreError({ operation: "indexes", message: "made to fail" })
                )
              }),
            drop: () => Effect.void,
            pages: () =>
              Effect.sync(() =>
                [...stored].map(([pageId, pageVersion]) => ({ pageId, pageVersion }))
              ),
            deletePages: (_, pageIds) =>
              Effect.sync(() => pageIds.forEach((pageId) => stored.delete(pageId))),
            replacePage: (write) =>
              Effect.sync(() => void stored.set(write.pageId, write.pageVersion))
          })
        ),
        Layer.succeed(
          EmbeddingSettingsStore,
          partialService<EmbeddingSettingsStore["Service"]>("EmbeddingSettingsStore", {
            settings: () => Effect.succeed({ modelId: "fake", keepIndex: true, paused: false })
          })
        ),
        Layer.succeed(
          Wiki,
          partialService<Wiki["Service"]>("Wiki", { snapshot: () => Effect.succeed(START) })
        )
      )
    )
  )
  const indexed = () => Object.fromEntries(stored)
  const versions = (current: Snapshot) =>
    Object.fromEntries(
      current.pages
        .filter((page) => page.page.pageId !== "forgotten")
        .map((page) => [page.page.pageId, page.resource.versionId])
    )
  const settle = Effect.sleep("30 millis")

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const index = yield* WikiEmbeddingIndex
        yield* settle
        const atStart = { indexed: indexed(), refreshes }
        yield* index.schedule(START)
        yield* settle
        const sameHead = refreshes
        yield* index.schedule(MOVED)
        yield* settle
        const moved = indexed()
        failNext = true
        yield* index.schedule(AGAIN)
        yield* settle
        const failed = indexed()
        yield* index.schedule(AGAIN)
        yield* settle
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
