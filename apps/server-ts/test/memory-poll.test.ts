import { Effect } from "effect"
import { expect, it } from "vitest"

import { wikiEventProducer } from "../src/automations/producers/wiki.js"
import { WikiEmbeddingIndex } from "../src/embedding/wiki-index.js"
import { wikiError } from "../src/wiki/errors.js"
import { Wiki } from "../src/wiki/service.js"
import { partialService } from "./kit.js"

it("checks outside changes, then announces commits, then lets search catch up, each minute", async () => {
  const calls: Array<string> = []
  const wiki = partialService<Wiki["Service"]>("Wiki", {
    checkOutsideEdits: () =>
      Effect.sync(() => calls.push("check")).pipe(
        Effect.andThen(Effect.fail(wikiError("observe", "storage", "the scan could not run")))
      ),
    publishChanges: () => Effect.sync(() => calls.push("publish")).pipe(Effect.as({ queued: 0 })),
    snapshot: () => Effect.succeed({ head: "head-1", pages: [] })
  })
  const index = partialService<WikiEmbeddingIndex["Service"]>("WikiEmbeddingIndex", {
    schedule: (snapshot) => Effect.sync(() => void calls.push(`index ${snapshot.head}`))
  })
  const source = wikiEventProducer.source
  if (source.kind !== "always") throw new Error("the Memory poll runs always")
  await Effect.runPromise(
    source.poll.pipe(
      Effect.provideService(Wiki, wiki),
      Effect.provideService(WikiEmbeddingIndex, index)
    )
  )
  expect(calls).toEqual(["check", "publish", "index head-1"])
})
