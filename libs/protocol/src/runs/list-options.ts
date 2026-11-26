import { Schema } from "effect"
import { routeSegment } from "../common/routes.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"

export const RUN_PAGE = { first: "first", after: "after" } as const
export const RUN_PAGE_NEXT = { end: "end", more: "more" } as const
export const RUN_QUESTION_FILTER = {
  all: "all",
  space: "space",
  session: "session",
  task: "task"
} as const
export const RUN_LIST_FILTER = { all: "all", session: "session" } as const
export const RUN_QUESTION_STATE = { actionable: "actionable", all: "all" } as const

export type RunPage<Cursor> =
  | { readonly kind: typeof RUN_PAGE.first }
  | { readonly kind: typeof RUN_PAGE.after; readonly cursor: Cursor }

export type RunPageNext<Cursor> =
  | { readonly kind: typeof RUN_PAGE_NEXT.end }
  | { readonly kind: typeof RUN_PAGE_NEXT.more; readonly cursor: Cursor }

export type RunQuestionFilter =
  | { readonly kind: typeof RUN_QUESTION_FILTER.all }
  | { readonly kind: typeof RUN_QUESTION_FILTER.space; readonly space_id: string }
  | { readonly kind: typeof RUN_QUESTION_FILTER.session; readonly session_id: string }
  | { readonly kind: typeof RUN_QUESTION_FILTER.task; readonly item_id: string }

export type RunQuestionState = (typeof RUN_QUESTION_STATE)[keyof typeof RUN_QUESTION_STATE]

export interface RunQuestionListOptions {
  readonly filter: RunQuestionFilter
  readonly state: RunQuestionState
  readonly page: RunPage<string>
}

export interface WorkerAttemptPageOptions {
  readonly limit: number
  readonly page: RunPage<number>
}

export type RunListFilter =
  | { readonly kind: typeof RUN_LIST_FILTER.all }
  | { readonly kind: typeof RUN_LIST_FILTER.session; readonly session_id: string }

export interface RunListOptions {
  readonly filter: RunListFilter
  readonly active: boolean
  readonly limit: number
  readonly page: RunPage<string>
}

export interface RunEventPageOptions {
  readonly afterSequence: number
  readonly limit: number
}

export interface UsageReportOptions {
  readonly days: number
}

export interface SessionUsageOptions {
  readonly limit: number
}

export const RUN_LIST_PAGE_MAX = 500

const runPageSchema = <C extends Schema.Top>(cursor: C) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_PAGE.first) }),
    Schema.Struct({ kind: Schema.Literal(RUN_PAGE.after), cursor })
  ])

const runPageNextSchema = <C extends Schema.Top>(cursor: C) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_PAGE_NEXT.end) }),
    Schema.Struct({ kind: Schema.Literal(RUN_PAGE_NEXT.more), cursor })
  ])

export const RunCursorPageNextSchema = runPageNextSchema(Schema.NonEmptyString)

export const RunAttemptPageNextSchema = runPageNextSchema(PositiveIntSchema)

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

export const RunQuestionFilterSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_FILTER.all) }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_FILTER.space), space_id: identity }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_FILTER.session), session_id: identity }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_FILTER.task), item_id: identity })
])

export const RunQuestionStateSchema = Schema.Literals([
  RUN_QUESTION_STATE.actionable,
  RUN_QUESTION_STATE.all
] as const)

export const RunQuestionListOptionsSchema = Schema.Struct({
  filter: RunQuestionFilterSchema,
  state: RunQuestionStateSchema,
  page: runPageSchema(identity)
})

export const WORKER_ATTEMPT_PAGE_MAX = 100

export const WorkerAttemptPageOptionsSchema = Schema.Struct({
  limit: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(WORKER_ATTEMPT_PAGE_MAX)),
  page: runPageSchema(PositiveIntSchema)
})

export const RunListOptionsSchema = Schema.Struct({
  filter: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_LIST_FILTER.all) }),
    Schema.Struct({ kind: Schema.Literal(RUN_LIST_FILTER.session), session_id: routeSegment() })
  ]),
  active: Schema.Boolean,
  limit: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(RUN_LIST_PAGE_MAX)),
  page: runPageSchema(Schema.NonEmptyString)
})

export const RunEventPageOptionsSchema = Schema.Struct({
  afterSequence: NonNegativeIntSchema,
  limit: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(200))
})

export const UsageReportOptionsSchema = Schema.Struct({
  days: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(365))
})

export const SessionUsageOptionsSchema = Schema.Struct({
  limit: PositiveIntSchema.check(Schema.isLessThanOrEqualTo(50))
})
