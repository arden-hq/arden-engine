import {
  RecordedHistoryHttpQuerySchema,
  RecordedHistoryPageSchema
} from "../../persistence/history.js"
import {
  AutomationEventCatalogResponseSchema,
  AutomationListResponseSchema,
  AutomationRunsQuerySchema,
  AutomationRunsResponseSchema,
  AutomationSchema,
  DeleteAutomationResponseSchema,
  InternalCreateAutomationRequestSchema,
  ResetAutomationSettingInputSchema,
  RunAutomationResponseSchema,
  ToggleAutomationResponseSchema,
  UpdateAutomationInputSchema
} from "@arden-hq/protocol/effect/automations"
import { Schema } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { SessionLifecycleEventError } from "../../persistence/sessions/events.js"
import { completionErrors, storeErrors } from "../errors.js"

const automationEventQuery = Schema.Struct({
  after_seq: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  )
})

const automationDescriptionErrors = [...completionErrors, ...storeErrors] as const

export class AutomationsApi extends HttpApiGroup.make("automations", { topLevel: true })
  .add(
    HttpApiEndpoint.get("configurationHistory", "/automations/:taskId/configuration-history", {
      params: { taskId: Schema.NonEmptyString },
      query: RecordedHistoryHttpQuerySchema,
      success: RecordedHistoryPageSchema,
      error: storeErrors
    }),
    HttpApiEndpoint.get("list", "/automations", {
      success: AutomationListResponseSchema,
      error: [HttpApiError.InternalServerErrorNoContent]
    })
  )
  .add(
    HttpApiEndpoint.post("create", "/automations", {
      payload: InternalCreateAutomationRequestSchema,
      success: AutomationSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.get("eventCatalog", "/automations/event-catalog", {
      success: AutomationEventCatalogResponseSchema,
      error: [HttpApiError.InternalServerErrorNoContent]
    })
  )
  .add(
    HttpApiEndpoint.get("get", "/automations/:taskId", {
      params: { taskId: Schema.NonEmptyString },
      success: AutomationSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.post("description", "/automations/:taskId/description/generate", {
      params: { taskId: Schema.NonEmptyString },
      success: AutomationSchema,
      error: automationDescriptionErrors
    })
  )
  .add(
    HttpApiEndpoint.get("runs", "/automations/:taskId/runs", {
      params: { taskId: Schema.NonEmptyString },
      query: AutomationRunsQuerySchema,
      success: AutomationRunsResponseSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.post("toggle", "/automations/:taskId/toggle", {
      params: { taskId: Schema.NonEmptyString },
      success: ToggleAutomationResponseSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.post("run", "/automations/:taskId/run", {
      params: { taskId: Schema.NonEmptyString },
      success: RunAutomationResponseSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.post("runWithEvent", "/automations/:taskId/runs/:runId/run-with-event", {
      params: {
        taskId: Schema.NonEmptyString,
        runId: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
      },
      success: RunAutomationResponseSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.post("reset", "/automations/:taskId/reset", {
      params: { taskId: Schema.NonEmptyString },
      payload: ResetAutomationSettingInputSchema,
      success: AutomationSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.patch("update", "/automations/:taskId", {
      params: { taskId: Schema.NonEmptyString },
      payload: UpdateAutomationInputSchema,
      success: AutomationSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.delete("delete", "/automations/:taskId", {
      params: { taskId: Schema.NonEmptyString },
      success: DeleteAutomationResponseSchema,
      error: storeErrors
    })
  )
  .add(
    HttpApiEndpoint.get("events", "/automations/events", {
      query: automationEventQuery,
      success: HttpApiSchema.StreamSse({
        events: Sse.Event,
        error: SessionLifecycleEventError
      }),
      error: [HttpApiError.BadRequestNoContent, HttpApiError.InternalServerErrorNoContent]
    })
  ) {}
