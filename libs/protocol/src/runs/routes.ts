import { Schema } from "effect"
import { RunQuestionListOptionsSchema } from "./questions.js"
import { WorkerAttemptPageOptionsSchema } from "./attempts.js"

import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"

const RunIdSchema = routeSegment()
export const encodeTaskAttemptsPathEffect = (value: unknown) =>
  encodeRouteEffect(
    Schema.Struct({ itemId: routeSegment(), options: WorkerAttemptPageOptionsSchema }),
    value,
    ({ itemId, options }) =>
      appendSearch(`/spaces/work/${encodeSegment(itemId)}/attempts`, [
        ["cursor", options.cursor],
        ["limit", options.limit]
      ])
  )
export const encodeRunQuestionsPathEffect = (value: unknown) =>
  encodeRouteEffect(RunQuestionListOptionsSchema, value, (options) =>
    appendSearch("/chat/questions", [
      ["space_id", options.space_id],
      ["session_id", options.session_id],
      ["item_id", options.item_id],
      ["state", options.state],
      ["cursor", options.cursor]
    ])
  )
export const encodeRunQuestionAnswerPathEffect = (value: unknown) =>
  encodeRouteEffect(routeSegment(), value, (id) => `/chat/questions/${encodeSegment(id)}/answer`)
const RunEventPageRouteSchema = Schema.Struct({
  runId: RunIdSchema,
  options: Schema.Struct({
    afterSequence: Schema.optionalKey(NonNegativeIntSchema),
    limit: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(200)))
  })
})

const runPath = (runId: string): string => `/chat/runs/${encodeSegment(runId)}`

export const encodeRunDetailPathEffect = (value: unknown) =>
  encodeRouteEffect(RunIdSchema, value, runPath)

export const encodeRunEventPagePathEffect = (value: unknown) =>
  encodeRouteEffect(RunEventPageRouteSchema, value, ({ runId, options }) =>
    appendSearch(`${runPath(runId)}/events`, [
      ["after_sequence", options.afterSequence],
      ["limit", options.limit]
    ])
  )

const UsageReportRouteSchema = Schema.Struct({
  options: Schema.Struct({
    days: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(365)))
  })
})

export const encodeUsageReportPathEffect = (value: unknown) =>
  encodeRouteEffect(UsageReportRouteSchema, value, ({ options }) =>
    appendSearch("/usage", [["days", options.days]])
  )

const SessionUsageRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  options: Schema.Struct({
    limit: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(50)))
  })
})

export const encodeSessionUsagePathEffect = (value: unknown) =>
  encodeRouteEffect(SessionUsageRouteSchema, value, ({ sessionId, options }) =>
    appendSearch(`/usage/sessions/${encodeSegment(sessionId)}`, [["limit", options.limit]])
  )
