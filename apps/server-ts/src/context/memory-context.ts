import type {
  RunMemoryContext,
  RunMemoryCutReason,
  RunMemoryReader,
  RunMemorySource
} from "@arden-hq/protocol/runs"
import type { Actor } from "../execution/authority.js"
import {
  recallQuery,
  type MemoryRoom,
  type MemorySources,
  type RenderedMemory
} from "../memory/retrieval.js"
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

/** The Memory sources each reader is sent. */
export const MEMORY_READS: Readonly<
  Record<
    RunMemoryReader,
    {
      readonly standing: boolean
      readonly index: boolean
      readonly space: boolean
      readonly recall: boolean
    }
  >
> = {
  owner: { standing: true, index: true, space: true, recall: true },
  worker: { standing: true, index: true, space: false, recall: false }
}

// The Memory block is one budget in bytes. Sources take their allowance in this order, each
// at most what the block has left; recall gets the rest.
// - The block: the sum of the shares below, so no source gets less than before the one block.
const BLOCK_BYTES = 36_000
// - Standing facts are sent whole, first: writers keep each page to 9,000 characters
//   (core-memory.ts), the share this sum counts for them.
// - The index: the smallest size tried (4,000 to 10,000) that lists every page outside the
//   four largest folders on the owner's copy. Over it, folders fold and are counted.
const INDEX_BYTES = 10_000
// - The Space context: its size before the one block.
const SPACE_BYTES = 10_000
// - Recall: the rest, at least 7,000 when standing facts keep to their share: 6,000 for
//   pages, as before the one block, and 1,000 for its headings and notices.

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
 * The one place a run's Memory block is composed: every source gets its allowance in priority
 * order from one budget, renders itself into that room with its own notices, and is recorded
 * from what it rendered. Nothing is cut after rendering.
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
  let left = BLOCK_BYTES
  const room = (allowance: number, own: RunMemoryCutReason): MemoryRoom =>
    allowance <= left
      ? { bytes: allowance, reason: own }
      : { bytes: Math.max(0, left), reason: "block_budget" }
  const take = (rendered: RenderedMemory): RenderedMemory => {
    left -= rendered.text === undefined ? 0 : byteLength(rendered.text) + 2
    return rendered
  }
  const standing = take(sources?.standing ?? none)
  const index = take(sources?.index(room(INDEX_BYTES, "index_allowance")) ?? none)
  const spaced =
    space === undefined
      ? undefined
      : take(renderSpace(space, room(SPACE_BYTES, "space_page_allowance")))
  const recall =
    sources?.recall === undefined
      ? undefined
      : take(sources.recall({ bytes: Math.max(0, left), reason: "block_budget" }))
  return {
    core: textSection("Core Memory", standing.text),
    index: textSection("Memory index", index.text),
    space:
      space === undefined || spaced?.text === undefined
        ? []
        : [{ kind: "space", key: "Current Space", text: spaced.text, space: space.view }],
    recall: [
      ...textSection("Memory recall", recall?.text, "turn"),
      ...textSection(
        "Memory left out",
        leftOutNotice([...index.sources, ...(spaced?.sources ?? [])]),
        "turn"
      )
    ],
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

const LEFT_OUT_NAMES: Readonly<Record<RunMemorySource["kind"], string>> = {
  core: "a standing-facts page",
  index: "the Memory index",
  space: "the Current Space context",
  recalled: "a recalled page"
}

/** Names each whole source the block had no room for; recall names its own pages. */
const leftOutNotice = (sources: ReadonlyArray<RunMemorySource>): string | undefined => {
  const names = sources
    .filter((source) => source.outcome === "dropped" && source.reason === "block_budget")
    .map((source) => LEFT_OUT_NAMES[source.kind])
  return names.length === 0
    ? undefined
    : `## Memory left out\n\n[No room left in the Memory block for ${names.join(" or ")}. Use wiki_search and wiki_read_page.]`
}

/**
 * The Space context in its room. Its own renderer fits it and says what it cut; a context with
 * no room even for its head is left out whole.
 */
const renderSpace = (space: SpaceMemoryInput, room: MemoryRoom): RenderedMemory => {
  const rendered = renderSpaceContext(space.view, { maxBytes: room.bytes })
  const identity = {
    kind: "space" as const,
    space_id: space.view.space_id,
    page_id: space.page?.pageId ?? null,
    version: space.page?.version ?? null
  }
  const bytes = byteLength(rendered.text)
  if (bytes > room.bytes)
    return {
      text: undefined,
      sources: [{ ...identity, bytes: 0, outcome: "dropped", reason: "block_budget" }]
    }
  const source: RunMemorySource =
    rendered.page === "cut" || rendered.page === "dropped"
      ? { ...identity, bytes, outcome: rendered.page, reason: room.reason }
      : { ...identity, bytes, outcome: "whole", reason: null }
  return { text: rendered.text, sources: [source] }
}
