import { Schema } from "effect"

import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import { WorkflowRefSchema } from "./schema.js"
import type { Effect } from "effect/Effect"

const RouteTargetSchema = Schema.Struct({
  workflowRef: WorkflowRefSchema,
  sessionId: routeSegment()
})

const scriptPath = (workflowRef: string): string => `/scripts/${encodeSegment(workflowRef)}`

const routePathEffect = (value: unknown, action: "" | "/retry" | "/cancel") =>
  encodeRouteEffect(RouteTargetSchema, value, ({ workflowRef, sessionId }) =>
    appendSearch(`${scriptPath(workflowRef)}${action}`, [["session_id", sessionId]])
  )

/** Encode `GET /scripts/:workflowRef`. */
export const encodeScriptItemPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => routePathEffect(value, "")

/** Encode `POST /scripts/:workflowRef/retry`. */
export const encodeScriptRetryPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => routePathEffect(value, "/retry")

/** Encode `POST /scripts/:workflowRef/cancel`. */
export const encodeScriptCancelPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> => routePathEffect(value, "/cancel")
