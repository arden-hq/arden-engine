import type { RunMemoryContext, RunMemoryReader } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { prefetchTurnMemory } from "../src/context/turn-context.js"
import { MemoryError } from "../src/memory/capture-batches.js"
import type { MemoryTurn } from "../src/memory/service.js"
import type { MemorySources } from "../src/memory/retrieval.js"
import type { ChatWriteStore } from "../src/persistence/chat/store.js"
import type { PersistedSpace, SpaceStore } from "../src/persistence/spaces/store.js"
import type { SummaryStore } from "../src/persistence/summaries/store.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import { MEMORY_READS } from "../src/context/memory-context.js"
import { renderIndex } from "../src/memory/index-render.js"
import { partialService } from "./kit.js"

const SPACE: PersistedSpace = {
  inference: { enabled: false },
  space_id: "space-1",
  name: "Garden",
  instructions: null,
  instructions_source: null,
  page_path: "areas/garden.md",
  mark: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  archived_at: null,
  page_id: "garden"
}

const prefetch = (
  memory: MemoryTurn | undefined,
  reader: RunMemoryReader = "owner",
  spaceId: string | undefined = undefined
) => {
  const records: Array<RunMemoryContext> = []
  const services = {
    spaces: partialService<SpaceStore["Service"]>("SpaceStore", {
      get: () => Effect.succeed(SPACE),
      detail: () => Effect.succeed(null)
    }),
    summaries: partialService<SummaryStore["Service"]>("SummaryStore", {
      spaceChats: () => Effect.succeed([])
    }),
    work: partialService<WorkStore["Service"]>("WorkStore", {
      questions: () => Effect.succeed({ questions: [], next_cursor: null })
    }),
    chat: {
      recordMemoryContext: (input) => Effect.sync(() => void records.push(input.context))
    } satisfies Pick<ChatWriteStore["Service"], "recordMemoryContext">
  }
  return Effect.runPromise(
    prefetchTurnMemory(services, {
      sessionId: "chat-1",
      runId: "run-1",
      reader,
      spaceId,
      query: "Where does the garden plan stand?",
      memory,
      measure: (_part, effect) => effect
    })
  ).then((prefetched) => ({ ...prefetched, records }))
}

const SOURCES: MemorySources = {
  standing: () => ({
    text: "## Core Memory\n\n### Me\nPage: me.md\nPrefers short replies.",
    sources: [
      { kind: "core", page_id: "me", version: "v1", bytes: 20, outcome: "whole", reason: null }
    ]
  }),
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
      readContent: (pageId) =>
        Effect.succeed({ pageId, path: "areas/garden.md", version: "v1", content: "Beds." }),
      spaceList: (space) => (maxBytes) => renderIndex([], { kind: "space", space }, maxBytes),
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
    expect(none.records).toEqual([
      { reader: "owner", revision: null, query: null, budget: expect.any(Object), sources: [] }
    ])
    const failing = turn(() =>
      Effect.fail(new MemoryError({ operation: "recall", message: "broken", sessionId: "chat-1" }))
    )
    const failed = await prefetch(failing.memory)
    expect(sent(failed.memoryContext)).toEqual([])
    expect(failed.records).toEqual([
      { reader: "owner", revision: "rev-1", query: null, budget: expect.any(Object), sources: [] }
    ])
  })
})

describe("the Space block follows MEMORY_READS", () => {
  it.each(["owner", "worker"] as const)("for a %s run in a Space", async (reader) => {
    const { memory } = turn(() => Effect.succeed({ ...SOURCES, recall: undefined }))
    const prefetched = await prefetch(memory, reader, "space-1")
    const kinds = prefetched.records[0]?.sources.map((source) => source.kind) ?? []
    expect(prefetched.memoryContext.space.length > 0).toBe(MEMORY_READS[reader].space)
    expect(kinds.includes("space")).toBe(MEMORY_READS[reader].space)
  })

  it("sends it to the owner's own chats only: a helper's fork, a Task worker's and a Space review's prompts carry the Space already", () => {
    expect(MEMORY_READS.owner.space).toBe(true)
    expect(MEMORY_READS.worker.space).toBe(false)
  })
})
