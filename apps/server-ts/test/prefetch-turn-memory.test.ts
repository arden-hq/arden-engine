import type { RunMemoryContext, RunMemoryReader } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { prefetchTurnMemory } from "../src/context/turn-context.js"
import { MemoryError } from "../src/memory/capture-batches.js"
import type { MemoryTurn } from "../src/memory/service.js"
import type { MemorySources } from "../src/memory/retrieval.js"
import type { ChatWriteStore } from "../src/persistence/chat/store.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { SummaryStore } from "../src/persistence/summaries/store.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import { partialService } from "./kit.js"

// A chat outside a Space reads no Space store; the sources, the block and the record are what
// change.
const prefetch = (memory: MemoryTurn | undefined, reader: RunMemoryReader = "owner") => {
  const records: Array<RunMemoryContext> = []
  const services = {
    spaces: partialService<SpaceStore["Service"]>("SpaceStore", {}),
    summaries: partialService<SummaryStore["Service"]>("SummaryStore", {}),
    work: partialService<WorkStore["Service"]>("WorkStore", {}),
    chat: {
      recordMemoryContext: (input) => Effect.sync(() => void records.push(input.context))
    } satisfies Pick<ChatWriteStore["Service"], "recordMemoryContext">
  }
  return Effect.runPromise(
    prefetchTurnMemory(services, {
      sessionId: "chat-1",
      runId: "run-1",
      reader,
      spaceId: undefined,
      query: "Where does the garden plan stand?",
      memory,
      measure: (_part, effect) => effect
    })
  ).then((prefetched) => ({ ...prefetched, records }))
}

const SOURCES: MemorySources = {
  standing: {
    text: "## Core Memory\n\n### Me\nPage: me.md\nPrefers short replies.",
    sources: [
      { kind: "core", page_id: "me", version: "v1", bytes: 20, outcome: "whole", reason: null }
    ]
  },
  index: () => ({
    text: "## Memory index\n\n- projects/garden.md: The garden.",
    sources: [
      {
        kind: "index",
        root: "",
        listed: 1,
        folded: [],
        bytes: 40,
        outcome: "whole",
        reason: null
      }
    ]
  }),
  recall: () => ({
    text: "## Memory context\n\nNote.\n\n## Relevant Memory\n\n### Garden\nPage: projects/garden.md",
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

const turn = (
  sources: MemoryTurn["sources"]
): { readonly memory: MemoryTurn; readonly asked: Array<unknown> } => {
  const asked: Array<unknown> = []
  return {
    asked,
    memory: {
      revision: "rev-1",
      readContent: () => Effect.die(new Error("no Space page in this test")),
      sources: (input) => {
        asked.push(input)
        return sources(input)
      }
    }
  }
}

describe("prefetchTurnMemory outside a Space", () => {
  it("sends an owner standing facts, the index and recall in one block, and records them", async () => {
    const { memory, asked } = turn(() => Effect.succeed(SOURCES))
    const prefetched = await prefetch(memory)
    expect(asked).toEqual([
      { sessionId: "chat-1", recall: { query: "Where does the garden plan stand?" } }
    ])
    expect(prefetched.space).toBeUndefined()
    expect(prefetched.memoryContext.core[0]?.text).toContain("Page: me.md")
    expect(prefetched.memoryContext.index[0]?.text).toContain("projects/garden.md")
    expect(prefetched.memoryContext.recall[0]?.text).toContain("Page: projects/garden.md")
    expect(prefetched.records).toEqual([prefetched.memoryContext.record])
    expect(prefetched.records[0]).toMatchObject({
      reader: "owner",
      revision: "rev-1",
      query: "Where does the garden plan stand?"
    })
    expect(prefetched.records[0]?.sources.map((source) => source.kind)).toEqual([
      "core",
      "index",
      "recalled"
    ])
  })

  it("asks no recall for a worker, and records what it was sent", async () => {
    const { memory, asked } = turn(() => Effect.succeed({ ...SOURCES, recall: undefined }))
    const prefetched = await prefetch(memory, "worker")
    expect(asked).toEqual([{ sessionId: "chat-1" }])
    expect(prefetched.memoryContext.recall).toEqual([])
    expect(prefetched.records[0]).toMatchObject({ reader: "worker", query: null })
    expect(prefetched.records[0]?.sources.map((source) => source.kind)).toEqual(["core", "index"])
  })

  it("sends and records nothing from Memory when the turn has none, or when it fails", async () => {
    const none = await prefetch(undefined)
    const sent = (context: typeof none.memoryContext) => [
      ...context.core,
      ...context.index,
      ...context.recall
    ]
    expect(sent(none.memoryContext)).toEqual([])
    expect(none.records).toEqual([{ reader: "owner", revision: null, query: null, sources: [] }])
    const failing = turn(() =>
      Effect.fail(new MemoryError({ operation: "recall", message: "broken", sessionId: "chat-1" }))
    )
    const failed = await prefetch(failing.memory)
    expect(sent(failed.memoryContext)).toEqual([])
    expect(failed.records).toEqual([
      { reader: "owner", revision: "rev-1", query: null, sources: [] }
    ])
  })
})
