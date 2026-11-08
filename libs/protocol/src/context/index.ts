import { decoderFor } from "../common/boundary.js"
import { ContextExperimentReportSchema, ContextSelectionSchema } from "./experiments.js"
import { Schema } from "effect"
import { projectedDecoderFor, runBoundary } from "../common/boundary.js"
import {
  ContextCompactionResponseSchema,
  mapCompactionOutcome,
  encodeContextCompactionRequestEffect
} from "./schema.js"

export * from "./contracts.js"
export { contextParts, fullContext } from "./experiments.js"
export type {
  ContextSelection,
  ContextRun,
  ContextExperimentReport,
  ContextStage
} from "./experiments.js"

export const contextDecoders = {
  experiments: decoderFor(ContextExperimentReportSchema, "Invalid context experiment report"),
  compaction: projectedDecoderFor(
    ContextCompactionResponseSchema,
    mapCompactionOutcome,
    "Invalid context-compaction response"
  )
} as const

export const contextRequests = {
  selection(value: unknown): string {
    return JSON.stringify(
      runBoundary(
        Schema.decodeUnknownEffect(ContextSelectionSchema)(value, { onExcessProperty: "error" }),
        "Invalid context selection",
        "encode"
      )
    )
  },
  compact(sessionId?: string): string {
    return runBoundary(
      encodeContextCompactionRequestEffect(sessionId),
      "Invalid context-compaction request",
      "encode"
    )
  }
} as const

export const contextRoutes = {
  experiments: (sessionId: string) => `/context/experiments/${encodeURIComponent(sessionId)}`,
  compact: "/compact"
} as const
