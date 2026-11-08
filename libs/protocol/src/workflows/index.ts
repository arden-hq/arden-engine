import { decoderFor, makeEncoder, runBoundary } from "../common/boundary.js"
import type { ScriptRetryRequest, WorkflowRouteTarget } from "./contracts.js"
import {
  ScriptDetailSchema,
  ScriptSummarySchema,
  encodeScriptRetryRequestEffect
} from "./schema.js"
import {
  encodeScriptCancelPathEffect,
  encodeScriptItemPathEffect,
  encodeScriptRetryPathEffect
} from "./routes.js"

export * from "./contracts.js"
export * from "./status.js"

export const scriptDecoders = {
  detail: decoderFor(ScriptDetailSchema, "Invalid script-detail response"),
  summary: decoderFor(ScriptSummarySchema, "Invalid script response")
} as const

/** Serialize one stable mutation body; reuse it for HTTP retries. */
export const scriptRequests = {
  retry: makeEncoder<ScriptRetryRequest>(
    encodeScriptRetryRequestEffect,
    "Invalid script-retry request"
  )
} as const

export const scriptRoutes = {
  item(target: WorkflowRouteTarget): string {
    return runBoundary(encodeScriptItemPathEffect(target), "Invalid script route", "encode")
  },
  retry(target: WorkflowRouteTarget): string {
    return runBoundary(encodeScriptRetryPathEffect(target), "Invalid script-retry route", "encode")
  },
  cancel(target: WorkflowRouteTarget): string {
    return runBoundary(
      encodeScriptCancelPathEffect(target),
      "Invalid script-cancel route",
      "encode"
    )
  }
} as const
