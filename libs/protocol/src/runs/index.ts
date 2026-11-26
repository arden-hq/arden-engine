import { RunProgressSchema } from "./progress.js"
export type { RunProgress } from "./progress.js"
export { RUN_PROGRESS_EVENT_TYPES, RUN_PURPOSE, TOOL_TITLE } from "./progress.js"
import {
  HomePresenceResponseSchema,
  encodeHomePresenceEffect,
  type HomePresenceInput
} from "./home.js"
import { decoderFor, runBoundary } from "../common/boundary.js"
import { WorkerAttemptPageSchema } from "./attempts.js"
import type {
  RunEventPageOptions,
  RunListOptions,
  RunQuestionListOptions,
  SessionUsageOptions,
  UsageReportOptions,
  WorkerAttemptPageOptions
} from "./list-options.js"
import {
  PlanLimitsReportSchema,
  RunDetailSchema,
  RunEventPageSchema,
  RunListSchema
} from "./schema.js"
import { SessionUsageReportSchema, UsageReportSchema } from "./usage-report.js"
import {
  RunQuestionSchema,
  RunQuestionListSchema,
  encodeResolveRunQuestionEffect
} from "./questions.js"
import {
  encodeTaskAttemptsPathEffect,
  encodeRunDetailPathEffect,
  encodeRunQuestionsPathEffect,
  encodeRunQuestionAnswerPathEffect,
  encodeRunEventPagePathEffect,
  encodeRunListPathEffect,
  encodeSessionUsagePathEffect,
  encodeUsageReportPathEffect
} from "./routes.js"

export * from "./contracts.js"
export type { RunList } from "./schema.js"
export * from "./status.js"
export * from "./end.js"
export { MODEL_CALL_KINDS, usageGroup, type ModelCallKind, type UsageGroup } from "./usage.js"
export {
  OFFER_SAVED,
  OFFER_TOOL,
  QUESTION_PART,
  QUESTION_RESOLUTION,
  QUESTION_TEXT,
  RUN_QUESTION_STATUS,
  answerSaid,
  answerWords,
  isRuleSavedIn,
  settledQuestionDrawn
} from "./questions.js"
export type { RuleSavedIn } from "./questions.js"

export const runDecoders = {
  homePresence: decoderFor(HomePresenceResponseSchema, "Invalid Home presence response"),
  attempts: decoderFor(WorkerAttemptPageSchema, "Invalid worker attempts"),
  question: decoderFor(RunQuestionSchema, "Invalid Run question"),
  questions: decoderFor(RunQuestionListSchema, "Invalid Run questions"),
  progress: decoderFor(RunProgressSchema, "Invalid Run progress"),
  detail: decoderFor(RunDetailSchema, "Invalid Run detail"),
  eventPage: decoderFor(RunEventPageSchema, "Invalid Run event page"),
  list: decoderFor(RunListSchema, "Invalid Run list"),
  usageReport: decoderFor(UsageReportSchema, "Invalid usage report"),
  sessionUsage: decoderFor(SessionUsageReportSchema, "Invalid chat usage"),
  planLimits: decoderFor(PlanLimitsReportSchema, "Invalid plan limits")
} as const

export const runRoutes = {
  homePresence: "/home/presence",
  taskAttempts(itemId: string, options: WorkerAttemptPageOptions): string {
    return runBoundary(
      encodeTaskAttemptsPathEffect({ itemId, options }),
      "Invalid Task attempts route",
      "encode"
    )
  },
  questions(options: RunQuestionListOptions): string {
    return runBoundary(encodeRunQuestionsPathEffect(options), "Invalid question route", "encode")
  },
  answerQuestion(questionId: string): string {
    return runBoundary(
      encodeRunQuestionAnswerPathEffect(questionId),
      "Invalid answer route",
      "encode"
    )
  },
  progress(runId: string): string {
    return `${runRoutes.detail(runId)}/progress`
  },
  detail(runId: string): string {
    return runBoundary(encodeRunDetailPathEffect(runId), "Invalid Run route", "encode")
  },
  events(runId: string, options: RunEventPageOptions): string {
    return runBoundary(
      encodeRunEventPagePathEffect({ runId, options }),
      "Invalid Run events route",
      "encode"
    )
  },
  list(options: RunListOptions): string {
    return runBoundary(encodeRunListPathEffect(options), "Invalid Run list route", "encode")
  },
  planLimits: "/usage/limits",
  usage(options: UsageReportOptions): string {
    return runBoundary(encodeUsageReportPathEffect({ options }), "Invalid usage route", "encode")
  },
  sessionUsage(sessionId: string, options: SessionUsageOptions): string {
    return runBoundary(
      encodeSessionUsagePathEffect({ sessionId, options }),
      "Invalid chat usage route",
      "encode"
    )
  }
} as const

export const runEncoders = {
  answerQuestion(value: unknown): string {
    return runBoundary(encodeResolveRunQuestionEffect(value), "Invalid question answer", "encode")
  }
} as const

export const homeRequests = {
  presence(input: HomePresenceInput): string {
    return runBoundary(encodeHomePresenceEffect(input), "Invalid Home presence", "encode")
  }
}
