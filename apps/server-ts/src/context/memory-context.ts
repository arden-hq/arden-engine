import type { RunMemoryCutReason, RunMemoryOutcome, RunMemorySource } from "@arden-hq/protocol/runs"
import type { MemoryRecall, MemorySource } from "../memory/retrieval.js"
import {
  budgetContinuityContext,
  LIVE_CONTINUITY_CONTEXT_MAX_BYTES,
  type BudgetedContinuityContext,
  type ContinuityContextSource
} from "./continuity-budget.js"
import { textSection, type RuntimeSection } from "./runtime-update.js"
import type { SpacePageShown, SpaceView } from "./space-render.js"

/** A Space's rendered context, and its Memory page at the version read, when it has one. */
export interface SpaceMemoryInput {
  readonly view: SpaceView
  readonly text: string
  readonly page:
    | { readonly pageId: string; readonly version: string; readonly shown: SpacePageShown }
    | undefined
}

export interface MemoryContext {
  readonly core: ReadonlyArray<RuntimeSection>
  readonly space: ReadonlyArray<RuntimeSection>
  readonly recall: ReadonlyArray<RuntimeSection>
  /** What `core`, `space` and `recall` hold, source by source: the run's Memory record. */
  readonly record: ReadonlyArray<RunMemorySource>
  readonly telemetry: BudgetedContinuityContext["telemetry"]
}

interface Placement {
  readonly bytes: number
  readonly outcome: RunMemoryOutcome
  readonly reason: RunMemoryCutReason | null
}

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).byteLength

/**
 * The one place a run's Memory context becomes prompt sections. The continuity budget runs
 * here, and the record of every source is read off the same text the sections carry, so a
 * Memory source cannot reach the prompt without being recorded.
 */
export const assembleMemoryContext = ({
  space,
  recall,
  query
}: {
  readonly space: SpaceMemoryInput | undefined
  readonly recall: MemoryRecall | undefined
  /** The text the recall searched with. */
  readonly query: string
}): MemoryContext => {
  const continuitySources: Array<ContinuityContextSource> = []
  if (space !== undefined)
    continuitySources.push({
      identity: `space:${space.view.space_id}`,
      kind: "session",
      content: space.text,
      priority: 100
    })
  if (recall?.text !== null && recall?.text !== undefined)
    continuitySources.push({
      identity: `recall:${recall.revision ?? "none"}:${[
        ...new Set(
          recall.sources
            .filter((source) => source.placement.shown !== "dropped")
            .map((source) => source.pageId)
        )
      ]
        .sort()
        .join(",")}`,
      kind: "recall",
      content: recall.text,
      priority: 50
    })
  const continuity = budgetContinuityContext({
    sources: continuitySources,
    maxBytes: LIVE_CONTINUITY_CONTEXT_MAX_BYTES
  })
  const core = textSection("Core Memory", recall?.core ?? undefined)
  const recalled = textSection(
    "Memory recall",
    continuity.sources.find((source) => source.kind === "recall")?.content,
    "turn"
  )
  return {
    core,
    // The Space goes in whole: its share of the continuity budget only limits the recall.
    space:
      space === undefined
        ? []
        : [{ kind: "space", key: "Current Space", text: space.text, space: space.view }],
    recall: recalled,
    record: [
      ...(space === undefined ? [] : [spaceRecord(space)]),
      ...(recall === undefined
        ? []
        : pageRecords({
            recall,
            query,
            sentRecallBytes: byteLength(recalled[0]?.text ?? "")
          }))
    ],
    telemetry: continuity.telemetry
  }
}

const spaceRecord = (space: SpaceMemoryInput): RunMemorySource => ({
  kind: "space",
  space_id: space.view.space_id,
  page_id: space.page?.pageId ?? null,
  version: space.page?.version ?? null,
  bytes: byteLength(space.text),
  ...spacePagePlacement(space.page?.shown)
})

const spacePagePlacement = (
  shown: SpacePageShown | undefined
): Pick<Placement, "outcome" | "reason"> => {
  switch (shown) {
    case undefined:
    case "whole":
      return { outcome: "whole", reason: null }
    case "cut":
    case "dropped":
      return { outcome: shown, reason: "space_page_allowance" }
  }
}

/**
 * Core Memory is sent whole, outside the continuity budget. The recall is cut at
 * `sentRecallBytes`: a page block past that point was cut or dropped by the budget.
 */
const pageRecords = ({
  recall,
  query,
  sentRecallBytes
}: {
  readonly recall: MemoryRecall
  readonly query: string
  readonly sentRecallBytes: number
}): ReadonlyArray<RunMemorySource> => {
  const inCore = locator(recall.core)
  const inRecall = locator(recall.text)
  return recall.sources.map((source) => ({
    kind: source.role,
    page_id: source.pageId,
    version: source.version,
    revision: recall.revision,
    query: source.role === "recalled" && query !== "" ? query : null,
    ...placementOf(source, source.role === "core" ? inCore : inRecall, sentRecallBytes)
  }))
}

const placementOf = (
  source: MemorySource,
  locate: (block: string) => { readonly start: number; readonly bytes: number },
  sentRecallBytes: number
): Placement => {
  const allowance = source.role === "core" ? "core_page_budget" : "recall_allowance"
  if (source.placement.shown === "dropped")
    return { bytes: 0, outcome: "dropped", reason: allowance }
  const { start, bytes } = locate(source.placement.block)
  const shown = source.placement.shown
  const own: Placement = { bytes, outcome: shown, reason: shown === "cut" ? allowance : null }
  if (source.role === "core" || start + bytes <= sentRecallBytes) return own
  if (start >= sentRecallBytes) return { bytes: 0, outcome: "dropped", reason: "continuity_budget" }
  return { bytes: sentRecallBytes - start, outcome: "cut", reason: "continuity_budget" }
}

/** Finds each block, in order, in the text the recall built from those blocks. */
const locator = (text: string | null) => {
  let cursor = 0
  return (block: string): { readonly start: number; readonly bytes: number } => {
    const at = text === null ? -1 : text.indexOf(block, cursor)
    if (text === null || at < 0)
      throw new Error("A Memory recall source is missing from the text it was placed in")
    cursor = at + block.length
    return { start: byteLength(text.slice(0, at)), bytes: byteLength(block) }
  }
}
