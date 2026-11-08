import { Schema } from "effect"

import { appendSearch, encodeRouteEffect, encodeSegment, routeSegment } from "../common/routes.js"
import { WorkflowRefSchema } from "./schema.js"

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
export const encodeScriptItemPathEffect = (value: unknown) => routePathEffect(value, "")

/** Encode `POST /scripts/:workflowRef/retry`. */
export const encodeScriptRetryPathEffect = (value: unknown) => routePathEffect(value, "/retry")

/** Encode `POST /scripts/:workflowRef/cancel`. */
export const encodeScriptCancelPathEffect = (value: unknown) => routePathEffect(value, "/cancel")
