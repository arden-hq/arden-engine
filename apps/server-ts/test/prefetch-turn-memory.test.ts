import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { prefetchTurnMemory } from "../src/context/turn-context.js"
import { LIVE_CONTINUITY_CONTEXT_MAX_BYTES } from "../src/context/continuity-budget.js"
import { MemoryError } from "../src/memory/capture-batches.js"
import type { MemoryTurn } from "../src/memory/service.js"
import type { MemoryRecall } from "../src/memory/retrieval.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { SummaryStore } from "../src/persistence/summaries/store.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import { partialService } from "./kit.js"

// A chat outside a Space reads no Space store; the recall and the budget are what change.
const services = {
  spaces: partialService<SpaceStore["Service"]>("SpaceStore", {}),
  summaries: partialService<SummaryStore["Service"]>("SummaryStore", {}),
  work: partialService<WorkStore["Service"]>("WorkStore", {})
}

const recalled = (text: string): MemoryRecall => ({
  revision: "rev-1",
  core: "## Core Memory\nPage: me.md",
  text,
  sources: [{ pageId: "garden", path: "projects/garden.md", title: "Garden", version: "v1" }],
  pages: [{ path: "me.md", text: "Page: me.md", whole: true }]
})

const turn = (
  recall: MemoryTurn["recall"]
): { readonly memory: MemoryTurn; readonly asked: Array<unknown> } => {
  const asked: Array<unknown> = []
  return {
    asked,
    memory: {
      readContent: () => Effect.die(new Error("no Space page in this test")),
      recall: (input) => {
        asked.push(input)
        return recall(input)
      }
    }
  }
}

const prefetch = (memory: MemoryTurn | undefined) =>
  Effect.runPromise(
    prefetchTurnMemory(services, {
      sessionId: "chat-1",
      runId: "run-1",
      spaceId: undefined,
      query: "Where does the garden plan stand?",
      memory,
      measure: (_part, effect) => effect
    })
  )

describe("prefetchTurnMemory outside a Space", () => {
  it("sends Core Memory whole and the recalled pages through the budget", async () => {
    const { memory, asked } = turn(() => Effect.succeed(recalled("## Relevant Memory\nPage: x")))
    const prefetched = await prefetch(memory)
    expect(asked).toEqual([{ sessionId: "chat-1", query: "Where does the garden plan stand?" }])
    expect(prefetched.space).toBeUndefined()
    expect(prefetched.recall?.core).toContain("Page: me.md")
    expect(prefetched.continuity.sources).toMatchObject([
      { kind: "recall", content: "## Relevant Memory\nPage: x", truncated: false }
    ])
  })

  it("cuts recalled text over the budget and says how much", async () => {
    const long = "x".repeat(LIVE_CONTINUITY_CONTEXT_MAX_BYTES + 500)
    const prefetched = await prefetch(turn(() => Effect.succeed(recalled(long))).memory)
    expect(prefetched.continuity.sources[0]?.truncated).toBe(true)
    expect(prefetched.continuity.telemetry.truncatedBytes).toBe(500)
  })

  it("sends nothing from Memory when the turn has none, or when recall fails", async () => {
    const none = await prefetch(undefined)
    expect(none.recall).toBeUndefined()
    expect(none.continuity.sources).toEqual([])
    const failing = turn(() =>
      Effect.fail(new MemoryError({ operation: "recall", message: "broken", sessionId: "chat-1" }))
    )
    const failed = await prefetch(failing.memory)
    expect(failed.recall).toBeUndefined()
    expect(failed.continuity.sources).toEqual([])
  })
})
