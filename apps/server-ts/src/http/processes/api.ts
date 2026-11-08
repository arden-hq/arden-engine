import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import {
  ProcessSnapshotSchema,
  ProcessOutputSchema,
  ProcessActionSchema,
  StopProcessRequestSchema
} from "@arden-hq/protocol/effect/processes"

export class ProcessesApi extends HttpApiGroup.make("processes", { topLevel: true }).add(
  HttpApiEndpoint.get("snapshot", "/processes", { success: ProcessSnapshotSchema }),
  HttpApiEndpoint.get("output", "/processes/output", {
    query: { key: Schema.NonEmptyString },
    success: ProcessOutputSchema
  }),
  HttpApiEndpoint.post("stop", "/processes/stop", {
    payload: StopProcessRequestSchema,
    success: ProcessActionSchema,
    error: [HttpApiError.ConflictNoContent, HttpApiError.NotFoundNoContent]
  })
) {}
