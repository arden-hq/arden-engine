export { parseIntervalMinutes } from "./interval.js"
import { decoderFor, makeEncoder, projectedDecoderFor, runBoundary } from "../common/boundary.js"
import type {
  AutomationEventRouteOptions,
  AutomationRunsRouteOptions,
  CreateAutomationInput,
  ResetAutomationSettingInput,
  UpdateAutomationInput
} from "./contracts.js"
import {
  AutomationSchema,
  toAutomation,
  toAutomationList,
  AutomationListResponseSchema,
  AutomationEventCatalogResponseSchema,
  AutomationRunsResponseSchema,
  DeleteAutomationResponseSchema,
  RunAutomationResponseSchema,
  ToggleAutomationResponseSchema,
  encodeCreateAutomationRequestEffect,
  encodeResetAutomationSettingRequestEffect,
  encodeUpdateAutomationRequestEffect
} from "./schema.js"
import {
  encodeAutomationDescriptionPathEffect,
  encodeAutomationEventsPathEffect,
  encodeAutomationItemPathEffect,
  encodeAutomationResetPathEffect,
  encodeAutomationRunPathEffect,
  encodeAutomationRunsPathEffect,
  encodeAutomationRunWithEventPathEffect,
  encodeAutomationTogglePathEffect
} from "./routes.js"

export * from "./contracts.js"
export * from "./outcome.js"
export * from "./state.js"
export * from "./triggers.js"
export * from "./schedule.js"
export * from "./trigger-merge.js"

/** Plain response decoders for the live Automations routes. */
export const automationDecoders = {
  automation: projectedDecoderFor(AutomationSchema, toAutomation, "Invalid automation response"),
  list: projectedDecoderFor(
    AutomationListResponseSchema,
    toAutomationList,
    "Invalid automation-list response"
  ),
  runs: decoderFor(AutomationRunsResponseSchema, "Invalid automation-runs response"),
  eventCatalog: decoderFor(
    AutomationEventCatalogResponseSchema,
    "Invalid automation event catalog"
  ),
  toggle: decoderFor(ToggleAutomationResponseSchema, "Invalid automation-toggle response"),
  run: decoderFor(RunAutomationResponseSchema, "Invalid automation-run response"),
  deleted: decoderFor(DeleteAutomationResponseSchema, "Invalid automation-delete response")
} as const

/**
 * Validate and serialize mutation inputs. `create` adds a private retry key;
 * reuse its returned body if the same HTTP operation must be retried.
 */
export const automationRequests = {
  create: makeEncoder<CreateAutomationInput>(
    encodeCreateAutomationRequestEffect,
    "Invalid create-automation request"
  ),
  update: makeEncoder<UpdateAutomationInput>(
    encodeUpdateAutomationRequestEffect,
    "Invalid update-automation request"
  ),
  reset: makeEncoder<ResetAutomationSettingInput>(
    encodeResetAutomationSettingRequestEffect,
    "Invalid reset-automation request"
  )
} as const

const route = (
  program: ReturnType<typeof encodeAutomationItemPathEffect>,
  message: string
): string => runBoundary(program, message, "encode")

/** Validated paths for the live Automations collection, stream, and item controls. */
export const automationRoutes = {
  collection: "/automations",
  eventCatalog: "/automations/event-catalog",
  events(options: AutomationEventRouteOptions = {}): string {
    return runBoundary(
      encodeAutomationEventsPathEffect(options),
      "Invalid automation-events route",
      "encode"
    )
  },
  item(taskId: string): string {
    return route(encodeAutomationItemPathEffect(taskId), "Invalid automation route")
  },
  description(taskId: string): string {
    return route(
      encodeAutomationDescriptionPathEffect(taskId),
      "Invalid automation-description route"
    )
  },
  runs(taskId: string, options: AutomationRunsRouteOptions = {}): string {
    return runBoundary(
      encodeAutomationRunsPathEffect({ taskId, options }),
      "Invalid automation-runs route",
      "encode"
    )
  },
  toggle(taskId: string): string {
    return route(encodeAutomationTogglePathEffect(taskId), "Invalid automation-toggle route")
  },
  run(taskId: string): string {
    return route(encodeAutomationRunPathEffect(taskId), "Invalid automation-run route")
  },
  /** POST: start a run with the event a skipped run held back; answers like `run`. */
  runWithEvent(taskId: string, runId: number): string {
    return runBoundary(
      encodeAutomationRunWithEventPathEffect({ taskId, runId }),
      "Invalid automation run-with-event route",
      "encode"
    )
  },
  reset(taskId: string): string {
    return route(encodeAutomationResetPathEffect(taskId), "Invalid automation-reset route")
  }
} as const
