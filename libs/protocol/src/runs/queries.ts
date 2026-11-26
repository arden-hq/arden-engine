import { Schema } from "effect"
import {
  RUN_LIST_FILTER,
  RUN_LIST_PAGE_MAX,
  RUN_PAGE,
  RUN_QUESTION_FILTER,
  RunQuestionStateSchema,
  WORKER_ATTEMPT_PAGE_MAX,
  type RunListFilter,
  type RunListOptions,
  type RunPage,
  type RunQuestionFilter,
  type RunQuestionListOptions,
  type WorkerAttemptPageOptions
} from "./list-options.js"

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

const queryInt = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(minimum),
    Schema.isLessThanOrEqualTo(maximum)
  )

const ACTIVE_QUERY = { yes: "true", no: "false" } as const

const queryPages = <C extends Schema.Top>(cursor: C) =>
  [
    { page: Schema.Literal(RUN_PAGE.first) },
    { page: Schema.Literal(RUN_PAGE.after), cursor }
  ] as const

const pageOf = <C>(
  query:
    | { readonly page: typeof RUN_PAGE.first }
    | { readonly page: typeof RUN_PAGE.after; readonly cursor: C }
): RunPage<C> =>
  query.page === RUN_PAGE.first
    ? { kind: RUN_PAGE.first }
    : { kind: RUN_PAGE.after, cursor: query.cursor }

export const RunEventPageQuerySchema = Schema.Struct({
  after_sequence: queryInt(0, Number.MAX_SAFE_INTEGER),
  limit: queryInt(1, 200)
})

export const UsageQuerySchema = Schema.Struct({ days: queryInt(1, 365) })

export const SessionUsageQuerySchema = Schema.Struct({ limit: queryInt(1, 50) })

const runListFilters = [
  { filter: Schema.Literal(RUN_LIST_FILTER.all) },
  { filter: Schema.Literal(RUN_LIST_FILTER.session), session_id: Schema.NonEmptyString }
] as const

const runListPages = queryPages(Schema.NonEmptyString)

export const RunListQuerySchema = Schema.Union(
  runListFilters.flatMap((filter) =>
    runListPages.map((page) =>
      Schema.Struct({
        active: Schema.Literals([ACTIVE_QUERY.yes, ACTIVE_QUERY.no] as const),
        limit: queryInt(1, RUN_LIST_PAGE_MAX),
        ...filter,
        ...page
      })
    )
  )
)

const runListFilterOf = (query: typeof RunListQuerySchema.Type): RunListFilter =>
  query.filter === RUN_LIST_FILTER.session
    ? { kind: RUN_LIST_FILTER.session, session_id: query.session_id }
    : { kind: RUN_LIST_FILTER.all }

export const runListOptions = (query: typeof RunListQuerySchema.Type): RunListOptions => ({
  filter: runListFilterOf(query),
  active: query.active === ACTIVE_QUERY.yes,
  limit: query.limit,
  page: pageOf(query)
})

export const WorkerAttemptPageQuerySchema = Schema.Union(
  queryPages(queryInt(1, Number.MAX_SAFE_INTEGER)).map((page) =>
    Schema.Struct({ limit: queryInt(1, WORKER_ATTEMPT_PAGE_MAX), ...page })
  )
)

export const workerAttemptPageOptions = (
  query: typeof WorkerAttemptPageQuerySchema.Type
): WorkerAttemptPageOptions => ({ limit: query.limit, page: pageOf(query) })

const questionFilters = [
  { filter: Schema.Literal(RUN_QUESTION_FILTER.all) },
  { filter: Schema.Literal(RUN_QUESTION_FILTER.space), space_id: identity },
  { filter: Schema.Literal(RUN_QUESTION_FILTER.session), session_id: identity },
  { filter: Schema.Literal(RUN_QUESTION_FILTER.task), item_id: identity }
] as const

const questionPages = queryPages(identity)

export const RunQuestionListQuerySchema = Schema.Union(
  questionFilters.flatMap((filter) =>
    questionPages.map((page) =>
      Schema.Struct({ state: RunQuestionStateSchema, ...filter, ...page })
    )
  )
)

const questionFilterOf = (query: typeof RunQuestionListQuerySchema.Type): RunQuestionFilter => {
  switch (query.filter) {
    case RUN_QUESTION_FILTER.all:
      return { kind: RUN_QUESTION_FILTER.all }
    case RUN_QUESTION_FILTER.space:
      return { kind: RUN_QUESTION_FILTER.space, space_id: query.space_id }
    case RUN_QUESTION_FILTER.session:
      return { kind: RUN_QUESTION_FILTER.session, session_id: query.session_id }
    case RUN_QUESTION_FILTER.task:
      return { kind: RUN_QUESTION_FILTER.task, item_id: query.item_id }
  }
}

export const runQuestionListOptions = (
  query: typeof RunQuestionListQuerySchema.Type
): RunQuestionListOptions => ({
  filter: questionFilterOf(query),
  state: query.state,
  page: pageOf(query)
})
