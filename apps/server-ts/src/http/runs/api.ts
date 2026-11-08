import { RunsStatusSchema } from "@arden-hq/protocol/effect/chat"
import {
  RunDetailSchema,
  RunEventPageQuerySchema,
  RunEventPageSchema,
  RunProgressSchema,
  PlanLimitsReportSchema,
  SessionUsageQuerySchema,
  SessionUsageReportSchema,
  UsageQuerySchema,
  UsageReportSchema
} from "@arden-hq/protocol/effect/runs"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class RunsApi extends HttpApiGroup.make("runs", { topLevel: true }).add(
  HttpApiEndpoint.get("status", "/chat/runs/status", {
    success: RunsStatusSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("detail", "/chat/runs/:runId", {
    params: {
      runId: Schema.NonEmptyString.check(Schema.isMaxLength(1_024))
    },
    success: RunDetailSchema,
    error: [HttpApiError.NotFoundNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("progress", "/chat/runs/:runId/progress", {
    params: { runId: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)) },
    success: RunProgressSchema,
    error: [HttpApiError.NotFoundNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("events", "/chat/runs/:runId/events", {
    params: {
      runId: Schema.NonEmptyString.check(Schema.isMaxLength(1_024))
    },
    query: RunEventPageQuerySchema,
    success: RunEventPageSchema,
    error: [
      HttpApiError.BadRequestNoContent,
      HttpApiError.NotFoundNoContent,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.get("planLimits", "/usage/limits", {
    success: PlanLimitsReportSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("usage", "/usage", {
    query: UsageQuerySchema,
    success: UsageReportSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("sessionUsage", "/usage/sessions/:sessionId", {
    params: { sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)) },
    query: SessionUsageQuerySchema,
    success: SessionUsageReportSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  })
) {}
