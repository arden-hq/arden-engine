import { Schema } from "effect"

import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"

const AutomationIdSchema = routeSegment()
const AutomationEventRouteOptionsSchema = Schema.Struct({
  afterSeq: Schema.optionalKey(NonNegativeIntSchema)
})
const AutomationRunsRouteSchema = Schema.Struct({
  taskId: AutomationIdSchema,
  options: Schema.Struct({
    limit: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(200)))
  })
})

const automationPath = (taskId: string): string => `/automations/${encodeSegment(taskId)}`

const itemPathEffect = (value: unknown, suffix = "") =>
  encodeRouteEffect(AutomationIdSchema, value, (taskId) => `${automationPath(taskId)}${suffix}`)

export const encodeAutomationEventsPathEffect = (value: unknown) =>
  encodeRouteEffect(AutomationEventRouteOptionsSchema, value, (options) =>
    appendSearch("/automations/events", [["after_seq", options.afterSeq]])
  )

export const encodeAutomationItemPathEffect = (value: unknown) => itemPathEffect(value)
export const encodeAutomationDescriptionPathEffect = (value: unknown) =>
  itemPathEffect(value, "/description/generate")
export const encodeAutomationTogglePathEffect = (value: unknown) => itemPathEffect(value, "/toggle")
export const encodeAutomationRunPathEffect = (value: unknown) => itemPathEffect(value, "/run")
export const encodeAutomationResetPathEffect = (value: unknown) => itemPathEffect(value, "/reset")

export const encodeAutomationRunsPathEffect = (value: unknown) =>
  encodeRouteEffect(AutomationRunsRouteSchema, value, ({ taskId, options }) =>
    appendSearch(`${automationPath(taskId)}/runs`, [["limit", options.limit]])
  )

const AutomationSkippedRunRouteSchema = Schema.Struct({
  taskId: AutomationIdSchema,
  runId: PositiveIntSchema
})

/** "Run with this event": a run of the Automation with the event a skip held back. */
export const encodeAutomationRunWithEventPathEffect = (value: unknown) =>
  encodeRouteEffect(
    AutomationSkippedRunRouteSchema,
    value,
    ({ taskId, runId }) => `${automationPath(taskId)}/runs/${runId}/run-with-event`
  )
