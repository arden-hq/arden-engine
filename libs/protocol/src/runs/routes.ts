import { Schema } from "effect"
import {
  RUN_LIST_FILTER,
  RUN_PAGE,
  RUN_QUESTION_FILTER,
  RunEventPageOptionsSchema,
  RunListOptionsSchema,
  RunQuestionListOptionsSchema,
  SessionUsageOptionsSchema,
  UsageReportOptionsSchema,
  WorkerAttemptPageOptionsSchema,
  type RunListFilter,
  type RunPage,
  type RunQuestionFilter
} from "./list-options.js"

import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import type { Effect } from "effect/Effect"

type SearchEntries = ReadonlyArray<readonly [string, string | number]>

const RunIdSchema = routeSegment()

const pageParams = <C extends string | number>(page: RunPage<C>): SearchEntries =>
  page.kind === RUN_PAGE.first
    ? [["page", page.kind]]
    : [
        ["page", page.kind],
        ["cursor", page.cursor]
      ]

const questionFilterParams = (filter: RunQuestionFilter): SearchEntries => {
  switch (filter.kind) {
    case RUN_QUESTION_FILTER.all:
      return [["filter", filter.kind]]
    case RUN_QUESTION_FILTER.space:
      return [
        ["filter", filter.kind],
        ["space_id", filter.space_id]
      ]
    case RUN_QUESTION_FILTER.session:
      return [
        ["filter", filter.kind],
        ["session_id", filter.session_id]
      ]
    case RUN_QUESTION_FILTER.task:
      return [
        ["filter", filter.kind],
        ["item_id", filter.item_id]
      ]
  }
}

const runListFilterParams = (filter: RunListFilter): SearchEntries =>
  filter.kind === RUN_LIST_FILTER.all
    ? [["filter", filter.kind]]
    : [
        ["filter", filter.kind],
        ["session_id", filter.session_id]
      ]

export const encodeTaskAttemptsPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(
    Schema.Struct({ itemId: routeSegment(), options: WorkerAttemptPageOptionsSchema }),
    value,
    ({ itemId, options }) =>
      appendSearch(`/spaces/work/${encodeSegment(itemId)}/attempts`, [
        ["limit", options.limit],
        ...pageParams(options.page)
      ])
  )
export const encodeRunQuestionsPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(RunQuestionListOptionsSchema, value, (options) =>
    appendSearch("/chat/questions", [
      ...questionFilterParams(options.filter),
      ["state", options.state],
      ...pageParams(options.page)
    ])
  )
export const encodeRunQuestionAnswerPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(routeSegment(), value, (id) => `/chat/questions/${encodeSegment(id)}/answer`)

export const encodeRunListPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(RunListOptionsSchema, value, (options) =>
    appendSearch("/chat/runs", [
      ...runListFilterParams(options.filter),
      ["active", options.active],
      ["limit", options.limit],
      ...pageParams(options.page)
    ])
  )

const RunEventPageRouteSchema = Schema.Struct({
  runId: RunIdSchema,
  options: RunEventPageOptionsSchema
})

const runPath = (runId: string): string => `/chat/runs/${encodeSegment(runId)}`

export const encodeRunDetailPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => encodeRouteEffect(RunIdSchema, value, runPath)

export const encodeRunEventPagePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(RunEventPageRouteSchema, value, ({ runId, options }) =>
    appendSearch(`${runPath(runId)}/events`, [
      ["after_sequence", options.afterSequence],
      ["limit", options.limit]
    ])
  )

export const encodeUsageReportPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(Schema.Struct({ options: UsageReportOptionsSchema }), value, ({ options }) =>
    appendSearch("/usage", [["days", options.days]])
  )

const SessionUsageRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  options: SessionUsageOptionsSchema
})

export const encodeSessionUsagePathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(SessionUsageRouteSchema, value, ({ sessionId, options }) =>
    appendSearch(`/usage/sessions/${encodeSegment(sessionId)}`, [["limit", options.limit]])
  )
