import type { RunMemoryContext, RunMemoryReader } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { prefetchTurnMemory } from "../src/context/turn-context.js"
import { MemoryError } from "../src/memory/capture-batches.js"
import { renderSpacePageList } from "../src/memory/index-render.js"
import type { MemorySources } from "../src/memory/retrieval.js"
import type { MemoryTurn } from "../src/memory/service.js"
import type { PersistedSpace, SpaceStore } from "../src/persistence/spaces/store.js"
import { partialService, present } from "./kit.js"

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

const GARDEN: PersistedSpace = {
  inference: { enabled: true },
  space_id: "space-1",
  name: "Garden",
  instructions: null,
  instructions_source: null,
  page_id: "garden-space",
  page_path: "spaces/garden.md",
  mark: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  archived_at: null
}

/** With `spacePage`, the chat is in a Space whose Memory page has that content. */
const run = async (
  sources: MemoryTurn["sources"] | undefined,
  reader: RunMemoryReader,
  spacePage?: string
) => {
  const records: Array<RunMemoryContext> = []
  const memory: MemoryTurn | undefined = sources && {
    revision: "rev-1",
    readContent: (pageId) =>
      Effect.succeed({ pageId, path: "spaces/garden.md", version: "v1", content: spacePage ?? "" }),
    spaceList: (space) => (maxBytes) => renderSpacePageList([], space, maxBytes),
    sources
  }
  const prefetched = await Effect.runPromise(
    prefetchTurnMemory(
      {
        spaces: partialService<SpaceStore["Service"]>("SpaceStore", {
          get: () => Effect.succeed(GARDEN),
          detail: () => Effect.succeed(null)
        }),
        summaries: partialService("SummaryStore", { spaceChats: () => Effect.succeed([]) }),
        work: partialService("WorkStore", {
          questions: () => Effect.succeed({ questions: [], next_cursor: null })
        }),
        chat: {
          recordMemoryContext: (input) => Effect.sync(() => void records.push(input.context))
        }
      },
      {
        sessionId: "chat-1",
        runId: "run-1",
        reader,
        spaceId: spacePage === undefined ? undefined : GARDEN.space_id,
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

it("recall is told the part of a cut Space page that the sent Space text holds", async () => {
  const page = Array.from({ length: 200 }, (_, line) => `${line} ${"é".repeat(40)}\n`).join("")
  const asked: Array<Parameters<MemoryTurn["sources"]>[0]["recall"]> = []
  const { prefetched, records } = await run(
    (input) => Effect.sync(() => void asked.push(input.recall)).pipe(Effect.as(SOURCES)),
    "owner",
    page
  )
  const sent = present(asked[0]?.sent, "the sent part of the Space page")
  const section = present(prefetched.memoryContext.space[0], "the Space section")
  expect(sent.pageId).toBe("garden-space")
  expect(sent.chars).toBeGreaterThan(0)
  expect(sent.chars).toBeLessThan(page.length)
  expect(section.text).toContain(`${page.slice(0, sent.chars)}(The page continues`)
  const recorded = records[0]?.sources.find((source) => source.kind === "space")
  expect(recorded).toMatchObject({
    page_id: "garden-space",
    version: "v1",
    outcome: "cut",
    reason: "space_page_allowance",
    bytes: Buffer.byteLength(section.text)
  })
  expect(recorded?.bytes).toBeGreaterThan(section.text.length)
  expect(prefetched.space?.view.page?.content).toBe(page)
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
