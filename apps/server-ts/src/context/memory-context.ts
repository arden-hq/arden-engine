import type { RunMemoryContext, RunMemoryReader, RunMemorySource } from "@arden-hq/protocol/runs"
import type { Actor } from "../execution/authority.js"
import { recallQuery, type MemorySources, type RenderedMemory } from "../memory/retrieval.js"
import { textSection, type RuntimeSection } from "./runtime-update.js"
import { renderSpaceContext, type SpaceView } from "./space-render.js"

/**
 * Which Memory a run is sent, by its recorded actor. A person's chat turn reads as the owner,
 * whoever started the chat. Helpers, Task workers, Space reviews and runs with no recorded
 * actor read as workers: they act for the owner but have no owner text to recall from.
 * Automations bring their own prompt and read none; a helper reads what the run that started
 * it would, without recall.
 */
export const memoryReaderOf = (actor: Actor): RunMemoryReader | undefined => {
  switch (actor.kind) {
    case "person":
      return "owner"
    case "automation":
      return undefined
    case "agent":
      return actor.root === "automation" ? undefined : "worker"
    case "task_worker":
    case "space_review":
    case "unrecorded":
      return "worker"
  }
}

/** The Memory sources each reader is sent besides standing facts and the index, which every
 *  reader is sent. */
export const MEMORY_READS: Readonly<
  Record<RunMemoryReader, { readonly space: boolean; readonly recall: boolean }>
> = {
  owner: { space: true, recall: true },
  worker: { space: false, recall: false }
}

// Each source of the Memory block has its own allowance, renders itself into it with its own
// notices, and takes no room from another, so the block is at most their sum.
// - Standing facts: each page up to its writer limit (core-memory.ts).
// - The index: the smallest size tried (4,000 to 10,000) that lists every page outside the
//   four largest folders on the owner's copy. Over it, folders fold.
const INDEX_BYTES = 10_000
// - The Space context: its size before the one block.
const SPACE_BYTES = 10_000
// - Recall: its size before the one block, 6,000 for pages, and 1,000 for its note, headings
//   and notices.
const RECALL_BYTES = 7_000

/** A Space's view, and its Memory page at the version read, when it has one. */
export interface SpaceMemoryInput {
  readonly view: SpaceView
  readonly page: { readonly pageId: string; readonly version: string } | undefined
}

export interface MemoryContext {
  readonly core: ReadonlyArray<RuntimeSection>
  readonly index: ReadonlyArray<RuntimeSection>
  readonly space: ReadonlyArray<RuntimeSection>
  readonly recall: ReadonlyArray<RuntimeSection>
  /** What the sections hold, source by source: one composition of the record. */
  readonly record: RunMemoryContext
}

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).byteLength

/**
 * The one place a run's Memory block is composed: every source renders itself into its own
 * allowance with its own notices, and is recorded from what it rendered.
 */
export const assembleMemoryContext = ({
  reader,
  sources,
  space,
  revision,
  query
}: {
  readonly reader: RunMemoryReader
  /** Undefined when Memory could not be read. */
  readonly sources: MemorySources | undefined
  readonly space: SpaceMemoryInput | undefined
  /** The Memory revision every source was read at. */
  readonly revision: string | null
  /** The text the recall searched with. */
  readonly query: string
}): MemoryContext => {
  const standing = sources?.standing ?? none
  const index = sources?.index(INDEX_BYTES) ?? none
  const spaced = space === undefined ? undefined : renderSpace(space)
  const recall = sources?.recall?.(RECALL_BYTES)
  return {
    core: textSection("Core Memory", standing.text),
    index: textSection("Memory index", index.text),
    space:
      space === undefined || spaced?.text === undefined
        ? []
        : [{ kind: "space", key: "Current Space", text: spaced.text, space: space.view }],
    recall: textSection("Memory recall", recall?.text, "turn"),
    record: {
      reader,
      revision,
      query: recall === undefined ? null : recallQuery(query),
      sources: [
        ...standing.sources,
        ...index.sources,
        ...(spaced?.sources ?? []),
        ...(recall?.sources ?? [])
      ]
    }
  }
}

const none: RenderedMemory = { text: undefined, sources: [] }

/**
 * The Space context in its allowance. Its own renderer fits it and says what it cut; a context
 * with no room even for its head is left out whole.
 */
const renderSpace = (space: SpaceMemoryInput): RenderedMemory => {
  const rendered = renderSpaceContext(space.view, { maxBytes: SPACE_BYTES })
  const identity = {
    kind: "space" as const,
    space_id: space.view.space_id,
    page_id: space.page?.pageId ?? null,
    version: space.page?.version ?? null
  }
  const bytes = byteLength(rendered.text)
  if (bytes > SPACE_BYTES)
    return {
      text: undefined,
      sources: [{ ...identity, bytes: 0, outcome: "dropped", reason: "space_allowance" }]
    }
  const source: RunMemorySource =
    rendered.page === "cut" || rendered.page === "dropped"
      ? { ...identity, bytes, outcome: rendered.page, reason: "space_page_allowance" }
      : { ...identity, bytes, outcome: "whole", reason: null }
  return { text: rendered.text, sources: [source] }
}
