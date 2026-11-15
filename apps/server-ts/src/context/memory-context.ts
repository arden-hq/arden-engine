import type {
  RunMemoryBudget,
  RunMemoryComposition,
  RunMemoryReader,
  RunMemorySource
} from "@arden-hq/protocol/runs"
import type { Actor } from "../execution/authority.js"
import { corePageBudget, STANDING_FACTS_PAGES } from "../memory/core-memory.js"
import type { RenderedIndex } from "../memory/index-render.js"
import { recallQuery, type MemorySources, type RenderedMemory } from "../memory/retrieval.js"
import { textSection, type RuntimeSection } from "./runtime-update.js"
import { renderSpaceContext, type SpaceView } from "./space-render.js"

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

const standingPageLimitChars = Math.max(
  ...STANDING_FACTS_PAGES.map((path) => {
    const limit = corePageBudget({ path, pageId: path })
    if (limit === undefined) throw new Error(`Standing-facts page ${path} has no writer limit`)
    return limit
  })
)
const MAX_UTF8_BYTES_PER_UTF16_UNIT = 3
const STANDING_PAGE_HEADING_BYTES = 1_000

/**
 * Every allowance in a run's Memory block, in UTF-8 bytes, under the names the run record
 * gives them. Each source renders itself into its own allowance with its own notices and takes
 * no room from another, so the block is at most `MEMORY_BLOCK_MAX_BYTES`.
 */
export const MEMORY_BUDGET = {
  standing_page:
    standingPageLimitChars * MAX_UTF8_BYTES_PER_UTF16_UNIT + STANDING_PAGE_HEADING_BYTES,
  /** The standing-facts note and section heading. */
  standing_frame: 1_000,
  index: 10_000,
  space: 10_000,
  space_page_list: 2_000,
  space_instructions: 4_000,
  space_page: 4_000,
  recall: 7_000
} as const satisfies RunMemoryBudget

export const MEMORY_BLOCK_MAX_BYTES =
  STANDING_FACTS_PAGES.length * MEMORY_BUDGET.standing_page +
  MEMORY_BUDGET.standing_frame +
  MEMORY_BUDGET.index +
  MEMORY_BUDGET.space +
  MEMORY_BUDGET.space_page_list +
  MEMORY_BUDGET.recall

/** A Space's view, and its Memory page at the version read with the list of the Space's other
 *  pages, when it has one. */
export interface SpaceMemoryInput {
  readonly view: SpaceView
  readonly page: SpacePageInput | undefined
}

export interface SpacePageInput {
  readonly pageId: string
  readonly version: string
  /** The generated list of the Space's other pages, in at most `maxBytes`. */
  readonly list: (maxBytes: number) => RenderedIndex
}

export interface MemoryContext {
  readonly core: ReadonlyArray<RuntimeSection>
  readonly index: ReadonlyArray<RuntimeSection>
  readonly space: ReadonlyArray<RuntimeSection>
  readonly recall: ReadonlyArray<RuntimeSection>
  /** What the sections hold, source by source: one composition of the record. */
  readonly record: RunMemoryComposition
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
  const standing = sources?.standing(MEMORY_BUDGET.standing_page) ?? none
  const spaced = space === undefined ? undefined : renderSpace(space)
  const list = space?.page?.list(MEMORY_BUDGET.space_page_list)
  const index =
    sources?.index({
      maxBytes: MEMORY_BUDGET.index,
      shownElsewhere: list?.shown ?? new Set()
    }) ?? none
  const recall = sources?.recall?.(MEMORY_BUDGET.recall)
  return {
    core: textSection("Core Memory", standing.text),
    index: textSection("Memory index", index.text),
    space:
      space === undefined || spaced === undefined
        ? []
        : [
            { kind: "space", key: "Current Space", text: spaced.text, space: space.view },
            ...textSection("Space pages", list?.text)
          ],
    recall: textSection("Memory recall", recall?.text, "turn"),
    record: {
      reader,
      revision,
      query: recall === undefined ? null : recallQuery(query),
      budget: MEMORY_BUDGET,
      sources: [
        ...standing.sources,
        ...index.sources,
        ...(spaced?.sources ?? []),
        ...(list?.sources ?? []),
        ...(recall?.sources ?? [])
      ]
    }
  }
}

const none: RenderedMemory = { text: undefined, sources: [] }

const renderSpace = (
  space: SpaceMemoryInput
): { readonly text: string; readonly sources: ReadonlyArray<RunMemorySource> } => {
  const rendered = renderSpaceContext(space.view, {
    maxBytes: MEMORY_BUDGET.space,
    instructionsBytes: MEMORY_BUDGET.space_instructions,
    pageBytes: MEMORY_BUDGET.space_page
  })
  const identity = {
    kind: "space" as const,
    space_id: space.view.space_id,
    page_id: space.page?.pageId ?? null,
    version: space.page?.version ?? null,
    bytes: byteLength(rendered.text)
  }
  const source: RunMemorySource =
    rendered.page === "cut" || rendered.page === "dropped"
      ? { ...identity, outcome: rendered.page, reason: "space_page_allowance" }
      : { ...identity, outcome: "whole", reason: null }
  return { text: rendered.text, sources: [source] }
}
