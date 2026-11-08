import {
  ScriptDetailSchema,
  ScriptOwnerQuerySchema,
  ScriptRetryRequestSchema,
  ScriptSummarySchema,
  WorkflowRefSchema
} from "@arden-hq/protocol/effect/workflows"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { StoreInvalid, StoreConflict } from "../errors.js"

const scriptErrors = [
  HttpApiError.BadRequestNoContent,
  HttpApiError.NotFoundNoContent,
  StoreConflict,
  StoreInvalid,
  HttpApiError.InternalServerErrorNoContent,
  HttpApiError.ServiceUnavailableNoContent
] as const

export class ScriptsApi extends HttpApiGroup.make("scripts", { topLevel: true }).add(
  HttpApiEndpoint.get("get", "/scripts/:workflowRef", {
    params: { workflowRef: WorkflowRefSchema },
    query: ScriptOwnerQuerySchema,
    success: ScriptDetailSchema,
    error: scriptErrors
  }),
  HttpApiEndpoint.post("retry", "/scripts/:workflowRef/retry", {
    params: { workflowRef: WorkflowRefSchema },
    query: ScriptOwnerQuerySchema,
    payload: ScriptRetryRequestSchema,
    success: ScriptSummarySchema.pipe(HttpApiSchema.status(202)),
    error: scriptErrors
  }),
  HttpApiEndpoint.post("cancel", "/scripts/:workflowRef/cancel", {
    params: { workflowRef: WorkflowRefSchema },
    query: ScriptOwnerQuerySchema,
    success: ScriptSummarySchema,
    error: scriptErrors
  })
) {}
