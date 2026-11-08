import { Schema } from "effect"

export type EndpointFailureReason = "key_refused" | "wrong_format" | "unreachable"

export class EndpointCallError extends Schema.TaggedError<EndpointCallError>()(
  "EndpointCallError",
  {
    reason: Schema.Literals(["key_refused", "wrong_format", "unreachable"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const failureForStatus = (status: number): EndpointFailureReason => {
  if (status === 401 || status === 403) return "key_refused"
  return [400, 404, 405, 415, 422].includes(status) ? "wrong_format" : "unreachable"
}

export const runtimeFailure = (reason: EndpointFailureReason): "key_refused" | "unreachable" =>
  reason === "key_refused" ? "key_refused" : "unreachable"
