import { RunProgressSchema } from "./progress.js"
export type { RunProgress } from "./progress.js"
export { RUN_PROGRESS_EVENT_TYPES } from "./progress.js"
import {
  HomeLetterResponseSchema,
  HomePresenceResponseSchema,
  encodeHomePresenceEffect,
  type HomePresenceInput
} from "./home.js"
export type { HomeLetter, HomeOffer } from "./home.js"
import { decoderFor, runBoundary } from "../common/boundary.js"
import {
  HomeEvidencePageSchema,
  encodeHomeEvidencePathEffect,
  type HomeEvidenceQuery
} from "./home.js"
import { WorkerAttemptPageSchema, type WorkerAttemptPageOptions } from "./attempts.js"
import type { RunEventPageOptions, SessionUsageOptions, UsageReportOptions } from "./contracts.js"
import {
  PlanLimitsReportSchema,
  RunDetailSchema,
  RunEventPageSchema,
  SessionUsageReportSchema,
  UsageReportSchema
} from "./schema.js"
import {
  RunQuestionSchema,
  RunQuestionListSchema,
  encodeResolveRunQuestionEffect,
  type RunQuestionListOptions
} from "./questions.js"
import {
  encodeTaskAttemptsPathEffect,
  encodeRunDetailPathEffect,
  encodeRunQuestionsPathEffect,
  encodeRunQuestionAnswerPathEffect,
  encodeRunEventPagePathEffect,
  encodeSessionUsagePathEffect,
  encodeUsageReportPathEffect
} from "./routes.js"

export * from "./contracts.js"
export * from "./status.js"
export * from "./end.js"
export { hasPlanCredits } from "./plan-credits.js"
export { MODEL_CALL_KINDS, usageGroup, type ModelCallKind, type UsageGroup } from "./usage.js"
export { answerSaid, answerWords, isRuleSavedIn, settledQuestionDrawn } from "./questions.js"
export type { RuleSavedIn } from "./questions.js"

export const runDecoders = {
  homePresence: decoderFor(HomePresenceResponseSchema, "Invalid Home presence response"),
  homeLetter: decoderFor(HomeLetterResponseSchema, "Invalid Home letter"),
  homeEvidence: decoderFor(HomeEvidencePageSchema, "Invalid Home evidence"),
  attempts: decoderFor(WorkerAttemptPageSchema, "Invalid worker attempts"),
  question: decoderFor(RunQuestionSchema, "Invalid Run question"),
  questions: decoderFor(RunQuestionListSchema, "Invalid Run questions"),
  progress: decoderFor(RunProgressSchema, "Invalid Run progress"),
  detail: decoderFor(RunDetailSchema, "Invalid Run detail"),
  eventPage: decoderFor(RunEventPageSchema, "Invalid Run event page"),
  usageReport: decoderFor(UsageReportSchema, "Invalid usage report"),
  sessionUsage: decoderFor(SessionUsageReportSchema, "Invalid chat usage"),
  planLimits: decoderFor(PlanLimitsReportSchema, "Invalid plan limits")
} as const

export const runRoutes = {
  homeLetter: "/home/letter",
  homePresence: "/home/presence",
  homeEvidence(options: HomeEvidenceQuery): string {
    return runBoundary(
      encodeHomeEvidencePathEffect(options),
      "Invalid Home evidence route",
      "encode"
    )
  },
  taskAttempts(itemId: string, options: WorkerAttemptPageOptions = {}): string {
    return runBoundary(
      encodeTaskAttemptsPathEffect({ itemId, options }),
      "Invalid Task attempts route",
      "encode"
    )
  },
  questions(options: RunQuestionListOptions = {}): string {
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
  events(runId: string, options: RunEventPageOptions = {}): string {
    return runBoundary(
      encodeRunEventPagePathEffect({ runId, options }),
      "Invalid Run events route",
      "encode"
    )
  },
  planLimits: "/usage/limits",
  usage(options: UsageReportOptions = {}): string {
    return runBoundary(encodeUsageReportPathEffect({ options }), "Invalid usage route", "encode")
  },
  sessionUsage(sessionId: string, options: SessionUsageOptions = {}): string {
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
