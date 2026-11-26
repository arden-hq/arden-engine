import { Schema } from "effect"
import type { JsonRecord } from "../common/json.js"
import { NonNegativeIntSchema, PositiveIntSchema, withExtras } from "../common/schema.js"

export const MEMORY_OUTCOME = {
  whole: "whole",
  passage: "passage",
  cut: "cut",
  dropped: "dropped"
} as const

export type RunMemoryOutcome = (typeof MEMORY_OUTCOME)[keyof typeof MEMORY_OUTCOME]

export type RunMemoryCutReason =
  | "standing_page_allowance"
  | "index_allowance"
  | "space_page_allowance"
  | "recall_allowance"

export type RunMemoryReader = "owner" | "worker"

export type RunMemoryPlacement =
  | {
      readonly bytes: number
      readonly outcome: typeof MEMORY_OUTCOME.whole | typeof MEMORY_OUTCOME.passage
    }
  | {
      readonly bytes: number
      readonly outcome: typeof MEMORY_OUTCOME.cut | typeof MEMORY_OUTCOME.dropped
      readonly reason: RunMemoryCutReason
    }

export const MEMORY_SPACE_PAGE = { none: "none", page: "page" } as const

export type RunMemorySpacePage =
  | { readonly kind: typeof MEMORY_SPACE_PAGE.none }
  | {
      readonly kind: typeof MEMORY_SPACE_PAGE.page
      readonly page_id: string
      readonly version: string
    }

export type RunMemorySpaceSource = JsonRecord & {
  readonly kind: "space"
  readonly space_id: string
  readonly page: RunMemorySpacePage
} & RunMemoryPlacement

export type RunMemoryCoreSource = JsonRecord & {
  readonly kind: "core"
  readonly page_id: string
  readonly version: string
} & RunMemoryPlacement

export type RunMemoryRecallRole = "knowledge" | "record" | "contract" | "unrecorded"

export type RunMemoryRecalledSource = JsonRecord & {
  readonly kind: "recalled"
  readonly role: RunMemoryRecallRole
  readonly page_id: string
  readonly version: string
} & RunMemoryPlacement

export type RunMemoryIndexSource = JsonRecord & {
  readonly kind: "index"
  readonly root: string
  readonly listed: number
  readonly folded: ReadonlyArray<{ readonly folder: string; readonly pages: number }>
} & RunMemoryPlacement

export type RunMemorySource =
  | RunMemorySpaceSource
  | RunMemoryCoreSource
  | RunMemoryRecalledSource
  | RunMemoryIndexSource

export interface RunMemoryAllowances extends JsonRecord {
  readonly standing_page: number
  readonly standing_frame: number
  readonly space: number
  readonly space_instructions: number
  readonly space_page: number
  readonly space_page_list: number
  readonly recall: number
}

export const MEMORY_BUDGET_STATE = { unrecorded: "unrecorded", recorded: "recorded" } as const

export type RunMemoryBudget = RunMemoryAllowances & {
  readonly kind: typeof MEMORY_BUDGET_STATE.recorded
}

export const MEMORY_REVISION = { unread: "unread", read: "read" } as const

export type RunMemoryRevision =
  | { readonly kind: typeof MEMORY_REVISION.unread }
  | { readonly kind: typeof MEMORY_REVISION.read; readonly revision: string }

export const MEMORY_RECALL = { none: "none", searched: "searched" } as const

export type RunMemoryRecall =
  | { readonly kind: typeof MEMORY_RECALL.none }
  | { readonly kind: typeof MEMORY_RECALL.searched; readonly query: string }

export interface RunMemoryContext extends JsonRecord {
  readonly reader: RunMemoryReader
  readonly revision: RunMemoryRevision
  readonly recall: RunMemoryRecall
  readonly budget: { readonly kind: typeof MEMORY_BUDGET_STATE.unrecorded } | RunMemoryBudget
  readonly sources: ReadonlyArray<RunMemorySource>
}

export type RunMemoryComposition = RunMemoryContext & { readonly budget: RunMemoryBudget }

const IdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))

const RunMemoryCutReasonSchema = Schema.Literals([
  "standing_page_allowance",
  "index_allowance",
  "space_page_allowance",
  "recall_allowance"
] as const)

const placements = [
  {
    bytes: NonNegativeIntSchema,
    outcome: Schema.Literals([MEMORY_OUTCOME.whole, MEMORY_OUTCOME.passage])
  },
  {
    bytes: NonNegativeIntSchema,
    outcome: Schema.Literals([MEMORY_OUTCOME.cut, MEMORY_OUTCOME.dropped]),
    reason: RunMemoryCutReasonSchema
  }
] as const

const pageFields = { page_id: IdentifierSchema, version: IdentifierSchema }

const sourceKinds = [
  {
    kind: Schema.Literal("space"),
    space_id: IdentifierSchema,
    page: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(MEMORY_SPACE_PAGE.none) }),
      Schema.Struct({ kind: Schema.Literal(MEMORY_SPACE_PAGE.page), ...pageFields })
    ])
  },
  { kind: Schema.Literal("core"), ...pageFields },
  {
    kind: Schema.Literal("recalled"),
    role: Schema.Literals(["knowledge", "record", "contract", "unrecorded"] as const),
    ...pageFields
  },
  {
    kind: Schema.Literal("index"),
    root: Schema.String,
    listed: NonNegativeIntSchema,
    folded: Schema.Array(withExtras({ folder: Schema.String, pages: PositiveIntSchema }))
  }
] as const

const RunMemorySourceSchema = Schema.Union(
  sourceKinds.flatMap((kind) =>
    placements.map((placement) => withExtras({ ...kind, ...placement }))
  )
)

const allowances = {
  standing_page: PositiveIntSchema,
  standing_frame: PositiveIntSchema,
  space: PositiveIntSchema,
  space_instructions: PositiveIntSchema,
  space_page: PositiveIntSchema,
  space_page_list: PositiveIntSchema,
  recall: PositiveIntSchema
}

export const RunMemoryContextSchema: Schema.Codec<RunMemoryContext> = withExtras({
  reader: Schema.Literals(["owner", "worker"] as const),
  revision: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MEMORY_REVISION.unread) }),
    Schema.Struct({ kind: Schema.Literal(MEMORY_REVISION.read), revision: IdentifierSchema })
  ]),
  recall: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MEMORY_RECALL.none) }),
    Schema.Struct({ kind: Schema.Literal(MEMORY_RECALL.searched), query: Schema.String })
  ]),
  budget: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(MEMORY_BUDGET_STATE.unrecorded) }),
    withExtras({ kind: Schema.Literal(MEMORY_BUDGET_STATE.recorded), ...allowances })
  ]),
  sources: Schema.Array(RunMemorySourceSchema)
})
