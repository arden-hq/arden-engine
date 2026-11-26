import { byteLength } from "@arden-hq/std/text"
import {
  MEMORY_BUDGET_STATE,
  MEMORY_RECALL,
  MEMORY_REVISION,
  MEMORY_SPACE_PAGE,
  type RunMemoryBudget,
  type RunMemoryComposition,
  type RunMemoryReader,
  type RunMemorySource
} from "@arden-hq/protocol/runs"
import type { Actor } from "../execution/authority.js"
import { corePageBudget, STANDING_FACTS_PAGES } from "../memory/core-memory.js"
import { recallQuery, type MemorySources, type RenderedMemory } from "../memory/retrieval.js"
import { textSection, type RuntimeSection } from "./runtime-update.js"
import { renderSpaceContext, type SpaceView } from "./space-render.js"

export const memoryReaderOf = (actor: Actor): RunMemoryReader | undefined =>
  actor.kind === "person" ? "owner" : undefined

const standingPageLimitChars = Math.max(
  ...STANDING_FACTS_PAGES.map((path) => {
    const limit = corePageBudget({ path, pageId: path })
    if (limit === undefined) throw new Error(`Standing-facts page ${path} has no writer limit`)
    return limit
  })
)
const MAX_UTF8_BYTES_PER_UTF16_UNIT = 3
const STANDING_PAGE_HEADING_BYTES = 1_000

const MEMORY_BUDGET = {
  kind: MEMORY_BUDGET_STATE.recorded,
  standing_page:
    standingPageLimitChars * MAX_UTF8_BYTES_PER_UTF16_UNIT + STANDING_PAGE_HEADING_BYTES,
  standing_frame: 1_000,
  space: 10_000,
  space_page_list: 2_000,
  space_instructions: 4_000,
  space_page: 4_000,
  recall: 7_000
} as const satisfies RunMemoryBudget

export interface SpaceMemoryInput {
  readonly view: SpaceView
  readonly page: SpacePageInput | undefined
}

export interface PreparedSpaceMemory extends SpaceMemoryInput {
  readonly rendered: ReturnType<typeof renderSpaceContext>
}

export interface SpacePageInput {
  readonly pageId: string
  readonly version: string
  readonly list: (maxBytes: number) => RenderedMemory
}

export interface MemoryContext {
  readonly core: ReadonlyArray<RuntimeSection>
  readonly space: ReadonlyArray<RuntimeSection>
  readonly recall: ReadonlyArray<RuntimeSection>
  readonly record: RunMemoryComposition
}

export const assembleMemoryContext = ({
  reader,
  sources,
  space,
  revision,
  query
}: {
  readonly reader: RunMemoryReader
  readonly sources: MemorySources | undefined
  readonly space: PreparedSpaceMemory | undefined
  readonly revision: string | null
  readonly query: string
}): MemoryContext => {
  const standing = sources?.standing(MEMORY_BUDGET.standing_page) ?? none
  const spaced = space === undefined ? undefined : renderSpace(space)
  const list = space?.page?.list(MEMORY_BUDGET.space_page_list)
  const recall = sources?.recall?.(MEMORY_BUDGET.recall)
  return {
    core: textSection("Core Memory", standing.text),
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
      revision:
        revision === null
          ? { kind: MEMORY_REVISION.unread }
          : { kind: MEMORY_REVISION.read, revision },
      recall:
        recall === undefined
          ? { kind: MEMORY_RECALL.none }
          : { kind: MEMORY_RECALL.searched, query: recallQuery(query) },
      budget: MEMORY_BUDGET,
      sources: [
        ...standing.sources,
        ...(spaced?.sources ?? []),
        ...(list?.sources ?? []),
        ...(recall?.sources ?? [])
      ]
    }
  }
}

const none: RenderedMemory = { text: undefined, sources: [] }

const SPACE_ROOM = {
  maxBytes: MEMORY_BUDGET.space,
  instructionsBytes: MEMORY_BUDGET.space_instructions,
  pageBytes: MEMORY_BUDGET.space_page
}

export const prepareSpaceMemory = (space: SpaceMemoryInput): PreparedSpaceMemory => ({
  ...space,
  rendered: renderSpaceContext(space.view, SPACE_ROOM)
})

const renderSpace = (
  space: PreparedSpaceMemory
): { readonly text: string; readonly sources: ReadonlyArray<RunMemorySource> } => {
  const rendered = space.rendered
  const identity = {
    kind: "space" as const,
    space_id: space.view.space_id,
    page:
      space.page === undefined
        ? { kind: MEMORY_SPACE_PAGE.none }
        : { kind: MEMORY_SPACE_PAGE.page, page_id: space.page.pageId, version: space.page.version },
    bytes: byteLength(rendered.text)
  }
  const source: RunMemorySource =
    rendered.page === undefined || rendered.page.outcome === "whole"
      ? { ...identity, outcome: "whole" }
      : { ...identity, outcome: rendered.page.outcome, reason: "space_page_allowance" }
  return { text: rendered.text, sources: [source] }
}
