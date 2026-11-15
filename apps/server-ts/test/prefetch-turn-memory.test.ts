import type { RunMemoryContext, RunMemoryReader } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { prefetchTurnMemory } from "../src/context/turn-context.js"
import { MemoryError } from "../src/memory/capture-batches.js"
import { renderSpacePageList } from "../src/memory/index-render.js"
import type { MemorySources } from "../src/memory/retrieval.js"
import type { MemoryTurn } from "../src/memory/service.js"
import { partialService } from "./kit.js"

const SOURCES: MemorySources = {
  standing: () => ({
    text: "## Core Memory",
    sources: [
      { kind: "core", page_id: "me", version: "v1", bytes: 20, outcome: "whole", reason: null }
    ]
  }),
  recall: () => ({
    text: "## Memory context",
    sources: [
      {
        kind: "recalled",
        page_id: "garden",
        version: "v1",
        bytes: 30,
        outcome: "whole",
        reason: null
      }
    ]
  })
}

const run = async (sources: MemoryTurn["sources"] | undefined, reader: RunMemoryReader) => {
  const records: Array<RunMemoryContext> = []
  const memory: MemoryTurn | undefined = sources && {
    revision: "rev-1",
    readContent: (pageId) => Effect.succeed({ pageId, path: "a.md", version: "v1", content: "" }),
    spaceList: (space) => (maxBytes) => renderSpacePageList([], space, maxBytes),
    sources
  }
  const prefetched = await Effect.runPromise(
    prefetchTurnMemory(
      {
        spaces: partialService("SpaceStore", {}),
        summaries: partialService("SummaryStore", {}),
        work: partialService("WorkStore", {}),
        chat: {
          recordMemoryContext: (input) => Effect.sync(() => void records.push(input.context))
        }
      },
      {
        sessionId: "chat-1",
        runId: "run-1",
        reader,
        spaceId: undefined,
        query: "garden?",
        memory,
        measure: (_part, effect) => effect
      }
    )
  )
  return { prefetched, records }
}

it("an owner is sent and recorded core and recall; a worker gets no recall", async () => {
  const owner = await run(() => Effect.succeed(SOURCES), "owner")
  expect(owner.records[0]?.sources.map((source) => source.kind)).toEqual(["core", "recalled"])
  const worker = await run(() => Effect.succeed({ ...SOURCES, recall: undefined }), "worker")
  expect(worker.prefetched.memoryContext.recall).toEqual([])
  expect(worker.records[0]).toMatchObject({ reader: "worker", query: null })
})

it("sends and records no sources when the turn has no Memory or Memory fails", async () => {
  const failing = () =>
    Effect.fail(new MemoryError({ operation: "recall", message: "broken", sessionId: "chat-1" }))
  for (const sources of [undefined, failing]) {
    const { prefetched, records } = await run(sources, "owner")
    expect(prefetched.memoryContext.core).toEqual([])
    expect(records[0]?.sources).toEqual([])
  }
})
