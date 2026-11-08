import { Schema } from "effect"
import { NonNegativeIntSchema } from "../common/schema.js"
import { ModelPhaseTimingSchema } from "../daemon/schema.js"

export const contextParts = [
  { key: "memory", label: "Memory recall + core memory" },
  { key: "space", label: "Space context + questions" },
  { key: "threads", label: "Related chats" },
  { key: "answers", label: "Answer-block values" },
  { key: "skills", label: "Skill catalog" },
  { key: "cliTools", label: "Command-line tool catalog" }
] as const
export type ContextPart = (typeof contextParts)[number]["key"]
export const ContextSelectionSchema = Schema.Struct({
  memory: Schema.Boolean,
  space: Schema.Boolean,
  threads: Schema.Boolean,
  answers: Schema.Boolean,
  skills: Schema.Boolean,
  cliTools: Schema.Boolean
})
export type ContextSelection = typeof ContextSelectionSchema.Type
export const fullContext: ContextSelection = {
  memory: true,
  space: true,
  threads: true,
  answers: true,
  skills: true,
  cliTools: true
}
export const ContextStageSchema = Schema.Struct({
  part: Schema.Literals(["memory", "space", "threads", "answers", "skills", "cliTools"]),
  durationMs: NonNegativeIntSchema,
  outcome: Schema.Literals(["completed", "failed", "skipped"])
})
export type ContextStage = typeof ContextStageSchema.Type
export const ContextRunSchema = Schema.Struct({
  runId: Schema.String,
  selection: ContextSelectionSchema,
  stages: Schema.Array(ContextStageSchema),
  phases: Schema.Array(ModelPhaseTimingSchema)
})
export type ContextRun = typeof ContextRunSchema.Type
export const ContextExperimentReportSchema = Schema.Struct({
  sessionId: Schema.String,
  selection: ContextSelectionSchema,
  runs: Schema.Array(ContextRunSchema)
})
export type ContextExperimentReport = typeof ContextExperimentReportSchema.Type
export const ContextExperimentParamsSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
})
