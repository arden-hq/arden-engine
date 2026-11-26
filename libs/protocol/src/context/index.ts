import { decoderFor } from "../common/boundary.js"
import { ContextExperimentReportSchema, ContextSelectionSchema } from "./experiments.js"
import { Schema } from "effect"
import { runBoundary } from "../common/boundary.js"
export { CONTEXT_STAGE_OUTCOME, contextParts, fullContext } from "./experiments.js"
export { CONTEXT_COMPACTION_STATUS } from "./schema.js"
export type { ContextCompactionResponse, ContextCompactionStatus } from "./schema.js"
export type {
  ContextStageOutcome,
  ContextSelection,
  ContextRun,
  ContextExperimentReport,
  ContextStage
} from "./experiments.js"

export const contextDecoders = {
  experiments: decoderFor(ContextExperimentReportSchema, "Invalid context experiment report")
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
  }
} as const

export const contextRoutes = {
  experiments: (sessionId: string) => `/context/experiments/${encodeURIComponent(sessionId)}`,
  compact: "/compact"
} as const
