import type { RunMemoryContext } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { prefetchTurnMemory } from "../src/context/turn-context.js"
import { LIVE_CONTINUITY_CONTEXT_MAX_BYTES } from "../src/context/continuity-budget.js"
import { MemoryError } from "../src/memory/capture-batches.js"
import type { MemoryTurn } from "../src/memory/service.js"
import type { MemoryRecall } from "../src/memory/retrieval.js"
import type { ChatWriteStore } from "../src/persistence/chat/store.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { SummaryStore } from "../src/persistence/summaries/store.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import { partialService } from "./kit.js"

// A chat outside a Space reads no Space store; the recall, the budget and the record are what
// change.
const prefetch = (memory: MemoryTurn | undefined) => {
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
      spaceId: undefined,
      query: "Where does the garden plan stand?",
      memory,
      measure: (_part, effect) => effect
    })
  ).then((prefetched) => ({ ...prefetched, records }))
}

const RECALLED_BLOCK = "Page: projects/garden.md\nThe seeds are ordered."

const recalled = (text: string): MemoryRecall => ({
  core: "## Core Memory\nPage: me.md",
  text,
  sources: [
    {
      role: "core",
      pageId: "me",
      path: "me.md",
      title: "Me",
      version: "v1",
      placement: { shown: "whole", block: "Page: me.md" }
    },
    {
      role: "recalled",
      pageId: "garden",
      path: "projects/garden.md",
      title: "Garden",
      version: "v1",
      placement: { shown: "whole", block: RECALLED_BLOCK }
    }
  ]
})

const turn = (
  recall: MemoryTurn["recall"]
): { readonly memory: MemoryTurn; readonly asked: Array<unknown> } => {
  const asked: Array<unknown> = []
  return {
    asked,
    memory: {
      revision: "rev-1",
      readContent: () => Effect.die(new Error("no Space page in this test")),
      recall: (input) => {
        asked.push(input)
        return recall(input)
      }
    }
  }
}

describe("prefetchTurnMemory outside a Space", () => {
  it("sends Core Memory whole and the recalled pages through the budget, and records both", async () => {
    const { memory, asked } = turn(() =>
      Effect.succeed(recalled(`## Relevant Memory\n${RECALLED_BLOCK}`))
    )
    const prefetched = await prefetch(memory)
    expect(asked).toEqual([{ sessionId: "chat-1", query: "Where does the garden plan stand?" }])
    expect(prefetched.space).toBeUndefined()
    expect(prefetched.memoryContext.core[0]?.text).toContain("Page: me.md")
    expect(prefetched.memoryContext.recall[0]?.text).toContain(RECALLED_BLOCK)
    expect(prefetched.records).toEqual([prefetched.memoryContext.record])
    expect(prefetched.records[0]?.sources).toMatchObject([
      { kind: "core", page_id: "me", outcome: "whole" },
      { kind: "recalled", page_id: "garden", outcome: "whole" }
    ])
  })

  it("cuts recalled text over the budget, and records the page it cut", async () => {
    const long = `## Relevant Memory\n${"x".repeat(LIVE_CONTINUITY_CONTEXT_MAX_BYTES)}\n${RECALLED_BLOCK}`
    const prefetched = await prefetch(turn(() => Effect.succeed(recalled(long))).memory)
    expect(prefetched.memoryContext.telemetry.truncatedBytes).toBeGreaterThan(0)
    expect(prefetched.records[0]?.sources[1]).toMatchObject({
      kind: "recalled",
      outcome: "dropped",
      reason: "continuity_budget"
    })
  })

  it("sends and records nothing from Memory when the turn has none, or when recall fails", async () => {
    const none = await prefetch(undefined)
    expect([...none.memoryContext.core, ...none.memoryContext.recall]).toEqual([])
    expect(none.records).toEqual([{ revision: null, query: null, sources: [] }])
    const failing = turn(() =>
      Effect.fail(new MemoryError({ operation: "recall", message: "broken", sessionId: "chat-1" }))
    )
    const failed = await prefetch(failing.memory)
    expect([...failed.memoryContext.core, ...failed.memoryContext.recall]).toEqual([])
    expect(failed.records).toEqual([{ revision: "rev-1", query: null, sources: [] }])
  })
})
