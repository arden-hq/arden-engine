import {
  SessionTerminalsResponseSchema,
  TerminalActionResponseSchema,
  TerminalInputRequestSchema,
  TerminalInputResponseSchema,
  TerminalOutputResponseSchema
} from "@arden-hq/protocol/effect/sessions/terminals"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

const terminalParams = {
  sessionId: Schema.NonEmptyString,
  terminalId: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
}

export class TerminalsApi extends HttpApiGroup.make("terminals", { topLevel: true }).add(
  HttpApiEndpoint.get("list", "/sessions/:sessionId/terminals", {
    params: { sessionId: Schema.NonEmptyString },
    success: SessionTerminalsResponseSchema
  }),
  HttpApiEndpoint.get("output", "/sessions/:sessionId/terminals/:terminalId/output", {
    params: terminalParams,
    query: {
      after: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
    },
    success: TerminalOutputResponseSchema,
    error: [HttpApiError.NotFoundNoContent]
  }),
  HttpApiEndpoint.post("input", "/sessions/:sessionId/terminals/:terminalId/input", {
    params: terminalParams,
    payload: TerminalInputRequestSchema,
    success: TerminalInputResponseSchema,
    error: [HttpApiError.NotFoundNoContent]
  }),
  HttpApiEndpoint.post("stop", "/sessions/:sessionId/terminals/:terminalId/stop", {
    params: terminalParams,
    success: TerminalActionResponseSchema,
    error: [HttpApiError.NotFoundNoContent]
  }),
  HttpApiEndpoint.delete("close", "/sessions/:sessionId/terminals/:terminalId", {
    params: terminalParams,
    success: TerminalActionResponseSchema
  })
) {}
